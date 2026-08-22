//! AI-agent endpoints (`prompt` / `interrupt` / `events`). The agent runner
//! is out of scope for this build; the endpoints exist and return a clear
//! error instead of faking agent output.

use axum::extract::{Extension, Path};
use axum::Json;

use crate::auth::ApiKeyAuth;
use crate::error::{ApiError, ApiResult};

pub async fn prompt_sandbox(
    _: Extension<ApiKeyAuth>,
    _: Path<String>,
    _: Option<Json<serde_json::Value>>,
) -> ApiResult<Json<serde_json::Value>> {
    Err(ApiError::not_implemented())
}

pub async fn interrupt_sandbox(
    _: Extension<ApiKeyAuth>,
    _: Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    Err(ApiError::not_implemented())
}

pub async fn events_sandbox(
    _: Extension<ApiKeyAuth>,
    _: Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    Err(ApiError::not_implemented())
}
