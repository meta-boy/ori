//! Account identity, limits, teams, and API keys.

use axum::Json;
use axum::extract::{Path, State};

use crate::auth::{self, ApiKeyAuth};
use crate::error::{ApiError, ApiResult};
use crate::proto::{
    Account, ApiKey, ApiKeyCreated, ApiKeyList, CreateApiKeyRequest, Limits, Team, TeamList,
    TypedId,
};
use crate::repo;
use crate::state::AppState;
use crate::util::now_ts;

const PLAN: &str = "free";
const MAX_RUNNING_SANDBOXES: i64 = 5;
const MAX_TOTAL_SANDBOXES: i64 = 20;
const MAX_STORAGE_GB: i64 = 50;
const RATE_LIMIT_PER_MINUTE: i64 = 120;

pub async fn me(State(_state): State<AppState>, auth: ApiKeyAuth) -> ApiResult<Json<Account>> {
    Ok(Json(Account {
        identifier: auth.account_id,
        login_state: "active".into(),
        plan: PLAN.into(),
        status: "active".into(),
    }))
}

pub async fn limits(
    State(state): State<AppState>,
    auth: ApiKeyAuth,
) -> ApiResult<Json<Limits>> {
    let (running, total) = repo::counts(&state.db, &auth.account_id).await?;
    Ok(Json(Limits {
        plan: PLAN.into(),
        max_running_sandboxes: MAX_RUNNING_SANDBOXES,
        max_total_sandboxes: MAX_TOTAL_SANDBOXES,
        max_storage_gb: MAX_STORAGE_GB,
        current_running: running,
        current_total: total,
        rate_limit_per_minute: RATE_LIMIT_PER_MINUTE,
    }))
}

pub async fn teams(State(_state): State<AppState>, _auth: ApiKeyAuth) -> ApiResult<Json<TeamList>> {
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
    auth: Option<ApiKeyAuth>,
    Json(req): Json<CreateApiKeyRequest>,
) -> ApiResult<Json<ApiKeyCreated>> {
    // First-user bootstrap: until one key exists, creation is unauthenticated
    // so the operator can mint the first key. After that, keys require auth.
    if auth.is_none() && auth::has_any_key(&state.db).await? {
        return Err(ApiError::unauthorized());
    }
    let account_id = auth.map(|a| a.account_id).unwrap_or_else(|| "default".to_string());

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
    auth: ApiKeyAuth,
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
    auth: ApiKeyAuth,
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