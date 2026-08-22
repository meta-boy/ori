//! Async operation status.

use axum::extract::{Extension, Path, State};
use axum::Json;

use crate::auth::ApiKeyAuth;
use crate::deletion;
use crate::error::{ApiError, ApiResult};
use crate::proto::OperationDetail;
use crate::state::AppState;

pub async fn get_operation(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
) -> ApiResult<Json<OperationDetail>> {
    let op = deletion::get_operation(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("operation {id}")))?;
    // operations are scoped to the account that created them
    let mine: (i64,) =
        sqlx::query_as("SELECT count(*) FROM deletion_operations WHERE id = ? AND account_id = ?")
            .bind(&id)
            .bind(&auth.account_id)
            .fetch_one(&state.db)
            .await?;
    if mine.0 == 0 {
        return Err(ApiError::not_found(format!("operation {id}")));
    }
    Ok(Json(OperationDetail {
        operation: op.to_operation(),
    }))
}
