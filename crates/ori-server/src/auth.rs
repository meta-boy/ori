//! Bearer API-key auth. Keys are hashed at rest with argon2 (never plaintext,
//! never a bare SHA); the raw secret appears only in the create response and
//! is never logged.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use sqlx::SqlitePool;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// The authenticated principal. Single personal scope for v1 (`default`),
/// modelled so a real account/team model can slot in later.
#[derive(Debug, Clone)]
pub struct ApiKeyAuth {
    pub account_id: String,
    pub key_id: String,
}

/// Hash a key secret into a PHC string. The salt is a fresh CSPRNG draw.
pub fn hash_secret(secret: &str) -> ApiResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(secret.as_bytes(), salt.as_str())
        .map(|h| h.to_string())
        .map_err(|e| ApiError::internal(format!("argon2 failure: {e}")))
}

/// Constant-time-ish verify of a presented secret against a stored PHC hash.
pub fn verify_secret(secret: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default().verify_password(secret.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

/// Look up the presented bearer secret among active keys. The at-rest hash is
/// salted, so we cannot index on it; we verify against each active key. Fine
/// at single-account scale; revisit with a keyed fingerprint if keys grow.
async fn authenticate(db: &SqlitePool, token: &str) -> ApiResult<ApiKeyAuth> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, account_id, key_hash FROM api_keys WHERE revoked_at IS NULL",
    )
    .fetch_all(db)
    .await?;
    for (key_id, account_id, hash) in rows {
        if verify_secret(token, &hash) {
            return Ok(ApiKeyAuth { account_id, key_id });
        }
    }
    Err(ApiError::unauthorized())
}

impl FromRequestParts<AppState> for ApiKeyAuth {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            let token = parts
                .headers
                .get(AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .ok_or_else(ApiError::unauthorized)?;
            authenticate(&state.db, token).await
        }
    }
}

/// Whether any API key exists yet. Used for first-user bootstrap: until the
/// first key exists, key creation is unauthenticated.
pub async fn has_any_key(db: &SqlitePool) -> ApiResult<bool> {
    let row: (i64,) = sqlx::query_as("SELECT count(*) FROM api_keys WHERE revoked_at IS NULL")
        .fetch_one(db)
        .await?;
    Ok(row.0 > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_roundtrip_and_salt() {
        let a = hash_secret("ori_sk_test").unwrap();
        let b = hash_secret("ori_sk_test").unwrap();
        // salted: same secret hashes differently
        assert_ne!(a, b);
        assert!(verify_secret("ori_sk_test", &a));
        assert!(verify_secret("ori_sk_test", &b));
        assert!(!verify_secret("ori_sk_wrong", &a));
        assert!(!verify_secret("ori_sk_test", "not-a-phc"));
    }
}