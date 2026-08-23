//! Account identity, teams, and API keys.

use axum::extract::{Extension, Path, State};
use axum::Json;

use crate::auth::{self, ApiKeyAuth};
use crate::error::{ApiError, ApiResult};
use crate::proto::{
    Account, ApiKey, ApiKeyCreated, ApiKeyList, ApiKeyRotated, CreateApiKeyRequest, Team, TeamList,
    TypedId,
};
use crate::state::AppState;
use crate::util::now_ts;

pub async fn me(
    State(_state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
) -> ApiResult<Json<Account>> {
    Ok(Json(Account {
        identifier: auth.0.account_id,
        login_state: "active".into(),
        status: "active".into(),
    }))
}

pub async fn teams(
    State(_state): State<AppState>,
    _auth: Extension<ApiKeyAuth>,
) -> ApiResult<Json<TeamList>> {
    // v1: a single personal billing scope.
    Ok(Json(TeamList {
        teams: vec![Team {
            id: "personal".into(),
            name: "Personal".into(),
            scope: "personal".into(),
            role: "owner".into(),
        }],
    }))
}

// -- api keys ---------------------------------------------------------------

pub async fn create_api_key(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<CreateApiKeyRequest>,
) -> ApiResult<Json<ApiKeyCreated>> {
    // This route lives outside the auth middleware: it is the bootstrap path
    // (no keys yet -> unauthenticated mint of the first key). If a bearer
    // token IS present, authenticate against it.
    let auth = match auth::bearer_token(&headers) {
        Some(token) => Some(auth::authenticate(&state.db, &token).await?),
        None => None,
    };
    if auth.is_none() && auth::has_any_key(&state.db).await? {
        return Err(ApiError::unauthorized());
    }
    let account_id = auth
        .map(|a| a.account_id)
        .unwrap_or_else(|| "default".to_string());

    let id = TypedId::api_key().to_string();
    let secret = TypedId::api_key_secret().to_string();
    let prefix = secret.chars().take(6).collect::<String>();
    let last_four = secret.chars().skip(secret.len() - 4).collect::<String>();
    let hash = auth::hash_secret(&secret)?;
    let now = now_ts();
    sqlx::query(
        "INSERT INTO api_keys (id, account_id, name, prefix, last_four, key_hash, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&account_id)
    .bind(&req.name)
    .bind(&prefix)
    .bind(&last_four)
    .bind(&hash)
    .bind(&now)
    .execute(&state.db)
    .await?;

    Ok(Json(ApiKeyCreated {
        id,
        name: req.name,
        prefix,
        last_four,
        secret,
        created_at: now,
    }))
}

pub async fn list_api_keys(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
) -> ApiResult<Json<ApiKeyList>> {
    #[derive(sqlx::FromRow)]
    struct KeyRow {
        id: String,
        name: Option<String>,
        prefix: String,
        last_four: String,
        created_at: String,
        revoked_at: Option<String>,
    }
    let rows = sqlx::query_as::<_, KeyRow>(
        "SELECT id, name, prefix, last_four, created_at, revoked_at FROM api_keys \
         WHERE account_id = ? ORDER BY created_at DESC",
    )
    .bind(&auth.account_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(ApiKeyList {
        api_keys: rows
            .into_iter()
            .map(|r| ApiKey {
                id: r.id,
                name: r.name,
                prefix: r.prefix,
                last_four: r.last_four,
                created_at: r.created_at,
                revoked_at: r.revoked_at,
            })
            .collect(),
    }))
}

pub async fn revoke_api_key(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let res = sqlx::query(
        "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
    )
    .bind(now_ts())
    .bind(&id)
    .bind(&auth.account_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("api key {id}")));
    }
    Ok(Json(serde_json::json!({})))
}

/// `POST /api-keys/{id}/rotate`: revoke the old key and mint a fresh one that
/// carries its name over. The new secret is shown exactly once, like `create`.
/// `current` tells the caller whether the rotated key was the one that made
/// this request — when true, its stored token is dead and must be replaced.
pub async fn rotate_api_key(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
) -> ApiResult<Json<ApiKeyRotated>> {
    let name: Option<String> = sqlx::query_scalar(
        "SELECT name FROM api_keys WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
    )
    .bind(&id)
    .bind(&auth.account_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::not_found(format!("api key {id}")))?;

    let now = now_ts();
    sqlx::query("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(&now)
        .bind(&id)
        .execute(&state.db)
        .await?;

    let new_id = TypedId::api_key().to_string();
    let secret = TypedId::api_key_secret().to_string();
    let prefix = secret.chars().take(6).collect::<String>();
    let last_four = secret.chars().skip(secret.len() - 4).collect::<String>();
    let hash = auth::hash_secret(&secret)?;
    sqlx::query(
        "INSERT INTO api_keys (id, account_id, name, prefix, last_four, key_hash, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&new_id)
    .bind(&auth.account_id)
    .bind(&name)
    .bind(&prefix)
    .bind(&last_four)
    .bind(&hash)
    .bind(&now)
    .execute(&state.db)
    .await?;

    Ok(Json(ApiKeyRotated {
        api_key: ApiKeyCreated {
            id: new_id,
            name,
            prefix,
            last_four,
            secret,
            created_at: now,
        },
        current: auth.key_id == id,
    }))
}
