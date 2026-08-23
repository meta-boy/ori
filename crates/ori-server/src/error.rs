//! Error taxonomy and its mapping to HTTP status + JSON error body.
//!
//! Every error renders as `{"error":{"code":...,"message":...}}`. Codes:
//! `not_found`, `conflict`, `invalid_transition`, `unauthorized`,
//! `capacity_exceeded`, `rate_limited`, `provider_unavailable`,
//! `invalid_request`, `not_implemented`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {}: {}",
            self.status.as_u16(),
            self.code,
            self.message
        )
    }
}

impl ApiError {
    pub fn invalid_request(msg: impl Into<String>) -> Self {
        ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
            message: msg.into(),
        }
    }

    pub fn not_found(what: impl Into<String>) -> Self {
        ApiError {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: what.into(),
        }
    }

    pub fn conflict(msg: impl Into<String>) -> Self {
        ApiError {
            status: StatusCode::CONFLICT,
            code: "conflict",
            message: msg.into(),
        }
    }

    pub fn invalid_transition(from: &str, to: &str) -> Self {
        ApiError {
            status: StatusCode::CONFLICT,
            code: "invalid_transition",
            message: format!("cannot transition {from} -> {to}"),
        }
    }

    pub fn unauthorized() -> Self {
        ApiError {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: "a valid API key is required".into(),
        }
    }

    /// The host cannot take another sandbox — thin-pool headroom or free
    /// memory is short. The message names which resource.
    pub fn capacity_exceeded(msg: impl Into<String>) -> Self {
        ApiError {
            status: StatusCode::CONFLICT,
            code: "capacity_exceeded",
            message: msg.into(),
        }
    }

    pub fn provider_unavailable(msg: impl Into<String>) -> Self {
        ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "provider_unavailable",
            message: msg.into(),
        }
    }

    pub fn not_implemented() -> Self {
        ApiError {
            status: StatusCode::NOT_IMPLEMENTED,
            code: "not_implemented",
            message: "not implemented in this build".into(),
        }
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        ApiError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: msg.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({ "error": { "code": self.code, "message": self.message } });
        (self.status, Json(body)).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "database error");
        ApiError::internal("database error")
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
