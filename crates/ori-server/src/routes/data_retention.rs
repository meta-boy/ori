//! Delete-on-stop toggle. When enabled, sandbox data is destroyed on stop
//! instead of being snapshotted — `resume` and `fork` have nothing to restore
//! from. Enabling is irreversible and destructive; the CLI requires explicit
//! confirmation and states the resume/fork consequence at enable time rather
//! than letting the user discover it on the next resume.

use axum::extract::{Extension, State};
use axum::Json;
use serde::Serialize;

use crate::auth::ApiKeyAuth;
use crate::error::ApiResult;
use crate::state::AppState;
use crate::util::now_ts;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRetentionStatus {
    /// Whether delete-on-stop is currently in force. `status` states plainly
    /// what is true right now — no hedging.
    pub enabled: bool,
}

pub async fn status(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
) -> ApiResult<Json<DataRetentionStatus>> {
    Ok(Json(DataRetentionStatus {
        enabled: retention_enabled(&state, &auth.account_id).await,
    }))
}

/// `POST /account/data-retention`: enable delete-on-stop. Idempotent —
/// enabling when already enabled is a 200, not an error.
pub async fn enable(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
) -> ApiResult<Json<DataRetentionStatus>> {
    sqlx::query(
        "INSERT INTO account_settings (account_id, data_retention_enabled, updated_at) \
         VALUES (?, 1, ?) \
         ON CONFLICT(account_id) DO UPDATE SET data_retention_enabled = 1, updated_at = excluded.updated_at",
    )
    .bind(&auth.account_id)
    .bind(now_ts())
    .execute(&state.db)
    .await?;
    Ok(Json(DataRetentionStatus { enabled: true }))
}

/// Whether the account has delete-on-stop enabled. Shared with the stop path
/// and the TTL reaper so the "snapshot on stop" behaviour is skipped exactly
/// where the toggle says it should be. `false` on any error — retention off is
/// the safe default (data-preserving).
pub async fn retention_enabled(state: &AppState, account_id: &str) -> bool {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT data_retention_enabled FROM account_settings WHERE account_id = ?")
            .bind(account_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    row.map(|(v,)| v != 0).unwrap_or(false)
}
