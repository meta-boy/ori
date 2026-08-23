//! Device-code login (`ori login --google/--email`) and the self-update
//! channel check. Both are unauthenticated entry points.

use axum::extract::{Path, State};
use axum::Json;
use serde::Serialize;

use crate::auth;
use crate::error::{ApiError, ApiResult};
use crate::proto::{Account, LoginPollResponse, LoginStartRequest, LoginStartResponse, TypedId};
use crate::state::AppState;
use crate::util::{now_ts, parse_ts};

const LOGIN_TTL_SECONDS: i64 = 15 * 60;
const USER_CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub async fn login_start(
    State(state): State<AppState>,
    Json(_req): Json<LoginStartRequest>,
) -> ApiResult<Json<LoginStartResponse>> {
    let id = TypedId::device_code().to_string();
    let user_code = random_user_code();
    let now = now_ts();
    let expires_at = crate::util::after_seconds(LOGIN_TTL_SECONDS);
    let url = format!(
        "https://{}/cli/login?code={}",
        state.config.domain, user_code
    );

    sqlx::query(
        "INSERT INTO device_codes (id, account_id, user_code, status, created_at, expires_at) \
         VALUES (?, 'default', ?, 'pending', ?, ?)",
    )
    .bind(&id)
    .bind(&user_code)
    .bind(&now)
    .bind(&expires_at)
    .execute(&state.db)
    .await?;

    Ok(Json(LoginStartResponse {
        id,
        code: user_code,
        url,
        expires_at,
    }))
}

pub async fn login_approve(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT status FROM device_codes WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    let Some((status,)) = row else {
        return Err(ApiError::not_found(format!("login {id}")));
    };
    if status != "pending" {
        return Err(ApiError::conflict(format!(
            "login {id} is {status}, not pending"
        )));
    }
    if let Some(exp) =
        sqlx::query_as::<_, (String,)>("SELECT expires_at FROM device_codes WHERE id = ?")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .ok()
            .and_then(|(s,)| parse_ts(&s))
    {
        if exp < chrono::Utc::now() {
            let _ = sqlx::query("UPDATE device_codes SET status = 'expired' WHERE id = ?")
                .bind(&id)
                .execute(&state.db)
                .await;
            return Err(ApiError::conflict("login code expired"));
        }
    }

    // Mint the key the poll will hand over exactly once.
    let key_id = TypedId::api_key().to_string();
    let secret = TypedId::api_key_secret().to_string();
    let prefix = secret.chars().take(6).collect::<String>();
    let last_four = secret.chars().skip(secret.len() - 4).collect::<String>();
    let hash = auth::hash_secret(&secret)?;
    let now = now_ts();
    sqlx::query(
        "INSERT INTO api_keys (id, account_id, name, prefix, last_four, key_hash, created_at) \
         VALUES (?, 'default', 'device-login', ?, ?, ?, ?)",
    )
    .bind(&key_id)
    .bind(&prefix)
    .bind(&last_four)
    .bind(&hash)
    .bind(&now)
    .execute(&state.db)
    .await?;

    sqlx::query(
        "UPDATE device_codes SET status = 'approved', key_id = ?, token = ?, approved_at = ? WHERE id = ?",
    )
    .bind(&key_id)
    .bind(&secret)
    .bind(&now)
    .bind(&id)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "status": "approved" })))
}

pub async fn login_poll(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<LoginPollResponse>> {
    #[derive(sqlx::FromRow)]
    struct CodeRow {
        status: String,
        expires_at: String,
        token: Option<String>,
        token_issued: bool,
    }
    let Some(mut row) = sqlx::query_as::<_, CodeRow>(
        "SELECT status, expires_at, token, token_issued FROM device_codes WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    else {
        return Err(ApiError::not_found(format!("login {id}")));
    };

    if row.status == "pending"
        && parse_ts(&row.expires_at)
            .map(|e| e < chrono::Utc::now())
            .unwrap_or(false)
    {
        sqlx::query("UPDATE device_codes SET status = 'expired' WHERE id = ?")
            .bind(&id)
            .execute(&state.db)
            .await?;
        row.status = "expired".into();
    }

    match row.status.as_str() {
        "pending" => Ok(Json(LoginPollResponse {
            status: "pending".into(),
            token: None,
            account: None,
        })),
        "expired" => Ok(Json(LoginPollResponse {
            status: "expired".into(),
            token: None,
            account: None,
        })),
        "approved" => {
            if row.token_issued {
                return Ok(Json(LoginPollResponse {
                    status: "active".into(),
                    token: None,
                    account: None,
                }));
            }
            let token = row
                .token
                .clone()
                .ok_or_else(|| ApiError::internal("approved login without token"))?;
            sqlx::query("UPDATE device_codes SET token_issued = 1, token = NULL WHERE id = ?")
                .bind(&id)
                .execute(&state.db)
                .await?;
            Ok(Json(LoginPollResponse {
                status: "active".into(),
                token: Some(token),
                account: Some(Account {
                    identifier: "default".into(),
                    login_state: "active".into(),
                    status: "active".into(),
                }),
            }))
        }
        other => Err(ApiError::internal(format!(
            "unexpected login state {other}"
        ))),
    }
}

/// `GET /cli/version` — the self-update channel check. This is the same
/// contract `latest.json` uses (docs/SPEC-API.md, install.sh): a release base
/// URL configured on the control plane, whose `latest.json` declares the
/// newest `version`/`channel` for the channel. The CLI compares against its own
/// version and, when an update is available, reuses `install.sh` (checksum
/// verified, refuses downgrades and channel jumps) rather than writing a second
/// updater.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliVersionResponse {
    pub current: String,
    pub latest: String,
    pub channel: String,
    pub update_available: bool,
    /// Where the CLI should fetch `install.sh`/`latest.json` to self-update.
    /// `None` when the control plane has no release channel configured.
    pub release_base_url: Option<String>,
}

pub async fn cli_version(State(state): State<AppState>) -> ApiResult<Json<CliVersionResponse>> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let Some(base) = state.config.release_base_url.clone() else {
        // No release channel: nothing to update to. Reporting current as
        // latest keeps the CLI's "already up to date" honest.
        return Ok(Json(CliVersionResponse {
            current: current.clone(),
            latest: current,
            channel: "stable".into(),
            update_available: false,
            release_base_url: None,
        }));
    };

    let (latest, channel) = match fetch_latest_json(&base).await {
        Some((v, c)) => (v, c.unwrap_or_else(|| "stable".into())),
        None => {
            // release base configured but unreachable/invalid: do not report a
            // phantom update — the CLI must not chase a version we cannot
            // verify exists
            tracing::warn!(base = %base, "could not fetch latest.json for self-update");
            return Ok(Json(CliVersionResponse {
                current: current.clone(),
                latest: current,
                channel: "stable".into(),
                update_available: false,
                release_base_url: Some(base),
            }));
        }
    };
    let update_available = version_gt(&latest, &current);
    Ok(Json(CliVersionResponse {
        current,
        latest,
        channel,
        update_available,
        release_base_url: Some(base),
    }))
}

/// Read `{base}/latest.json` (`{ "version": "…", "channel": "…", "platforms":
/// {…} }`). `base` may be an http(s) URL or a local directory, mirroring
/// install.sh's release-base handling.
async fn fetch_latest_json(base: &str) -> Option<(String, Option<String>)> {
    let base = base.trim_end_matches('/');
    let raw = if base.starts_with("http://") || base.starts_with("https://") {
        reqwest::get(format!("{base}/latest.json"))
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .text()
            .await
            .ok()?
    } else {
        std::fs::read_to_string(std::path::Path::new(base).join("latest.json")).ok()?
    };
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let version = v.get("version")?.as_str()?.to_string();
    let channel = v
        .get("channel")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());
    Some((version, channel))
}

/// Dot-separated numeric version comparison (same semantics as install.sh's
/// `ver_cmp`). Returns true when `a > b`.
fn version_gt(a: &str, b: &str) -> bool {
    let num = |s: &str| {
        s.split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
            })
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect::<Vec<u64>>()
    };
    let (aa, bb) = (num(a), num(b));
    let n = aa.len().max(bb.len());
    for i in 0..n {
        let x = aa.get(i).copied().unwrap_or(0);
        let y = bb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

fn random_user_code() -> String {
    let alphabet: Vec<char> = USER_CODE_ALPHABET.chars().collect();
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("CSPRNG failure");
    let part = |i: usize, n: usize| {
        bytes[i..i + n]
            .iter()
            .map(|b| alphabet[*b as usize % alphabet.len()])
            .collect::<String>()
    };
    format!("{}-{}", part(0, 4), part(4, 4))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_format() {
        let c = random_user_code();
        assert_eq!(c.len(), 9);
        assert_eq!(c.chars().nth(4), Some('-'));
        let no_ambiguous = c
            .chars()
            .filter(|c| *c != '-')
            .all(|c| USER_CODE_ALPHABET.contains(c));
        assert!(no_ambiguous);
    }
}
