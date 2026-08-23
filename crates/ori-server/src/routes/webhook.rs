//! Lifecycle webhooks: `ready | error | archived` notifications delivered over
//! HTTP, HMAC-signed so a receiver can authenticate the payload and reject
//! replays.
//!
//! Two concerns live here:
//!
//! - **Handlers** — `webhook {create,list,rotate,remove}`. The signing secret
//!   is shown exactly once at create/rotate, like an api key; afterwards only
//!   a prefix and last four are exposed.
//! - **Delivery engine** — `emit` enqueues a delivery row (a fast INSERT on
//!   the request path), a spawned task makes the first attempt immediately,
//!   and a background sweeper retries with exponential backoff up to
//!   `max_attempts`, then marks the delivery `dropped`. A dead endpoint never
//!   accumulates unbounded pending deliveries, and a slow receiver never
//!   delays a sandbox reaching `ready`.

use ori_proto::{CreateWebhookRequest, Webhook, WebhookCreated, WebhookList, WebhookRotated};
use std::time::Duration;

use axum::extract::{Extension, Path, State};
use axum::Json;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::time::MissedTickBehavior;

use crate::auth::ApiKeyAuth;
use crate::error::{ApiError, ApiResult};
use crate::proto::TypedId;
use crate::repo::SandboxRow;
use crate::state::AppState;
use crate::util::{after_seconds, now_ts};

type HmacSha256 = Hmac<Sha256>;

/// How many times a delivery is attempted (including the first) before it is
/// dropped and recorded as such. The retry budget, not a retry *rate*: the
/// guard is that a dead endpoint stops being retried.
const MAX_ATTEMPTS: i64 = 5;
/// Backoff before the *next* attempt: `base * 2^(attempt-1)` seconds
/// (1, 2, 4, 8) — attempt 2 waits 1 s, attempt 3 waits 2 s, and so on.
const BACKOFF_BASE_SECONDS: i64 = 1;
/// Upper bound on webhooks per account — the delivery queue is per-webhook, so
/// unbounded webhooks mean unbounded deliveries.
const MAX_WEBHOOKS: i64 = 20;
/// The three lifecycle events, in wire order.
const EVENTS: &str = "ready,error,archived";
/// A delivery stuck in `processing` longer than this (crash mid-flight) is
/// reclaimed as `pending` by the sweeper so it retries instead of stalling.
const STALE_PROCESSING_SECS: i64 = 300;

const DELIVERY_ALPHABET: &[char] = &[
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
];

fn gen_id(prefix: &str) -> String {
    TypedId::random(32, DELIVERY_ALPHABET, prefix).to_string()
}

/// `ori_ws_` + 40 hex — webhook signing secret, shown exactly once.
fn gen_secret() -> String {
    TypedId::random(40, DELIVERY_ALPHABET, "ori_ws_").to_string()
}

// ---------------------------------------------------------------------------
// wire DTOs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

pub async fn list_webhooks(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
) -> ApiResult<Json<WebhookList>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: String,
        url: String,
        events: String,
        prefix: String,
        last_four: String,
        created_at: String,
    }
    let rows = sqlx::query_as::<_, Row>(
        "SELECT id, url, events, prefix, last_four, created_at FROM webhooks \
         WHERE account_id = ? ORDER BY created_at DESC",
    )
    .bind(&auth.account_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(WebhookList {
        webhooks: rows
            .into_iter()
            .map(|r| Webhook {
                id: r.id,
                url: r.url,
                events: r.events,
                prefix: r.prefix,
                last_four: r.last_four,
                created_at: r.created_at,
                state: "active".into(),
            })
            .collect(),
    }))
}

pub async fn create_webhook(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Json(req): Json<CreateWebhookRequest>,
) -> ApiResult<Json<WebhookCreated>> {
    validate_url_async(&req.url, state.config.webhook_allow_private).await?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM webhooks WHERE account_id = ?")
        .bind(&auth.account_id)
        .fetch_one(&state.db)
        .await?;
    if count >= MAX_WEBHOOKS {
        return Err(ApiError::conflict(format!(
            "account has {MAX_WEBHOOKS} webhooks already; remove one before adding another"
        )));
    }

    let id = gen_id("oriwh_");
    let secret = gen_secret();
    let prefix: String = secret.chars().take(6).collect();
    let last_four: String = secret.chars().skip(secret.len() - 4).collect();
    let secret_hash = crate::auth::hash_secret(&secret)?;
    let now = now_ts();
    sqlx::query(
        "INSERT INTO webhooks (id, account_id, url, secret_hash, secret, prefix, last_four, \
         events, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&auth.account_id)
    .bind(&req.url)
    .bind(&secret_hash)
    .bind(&secret)
    .bind(&prefix)
    .bind(&last_four)
    .bind(EVENTS)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await?;

    Ok(Json(WebhookCreated {
        id,
        url: req.url,
        events: EVENTS.into(),
        prefix,
        last_four,
        secret,
        created_at: now,
    }))
}

/// `POST /webhooks/{id}/rotate`: mint a fresh signing secret, shown once. The
/// new secret immediately invalidates pending signatures the old one would
/// have produced for *future* attempts — a rotated-away webhook is still
/// delivered on the next retry because the delivery signs with the current
/// secret, and the receiver only accepts the new one.
pub async fn rotate_webhook(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
) -> ApiResult<Json<WebhookRotated>> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT url, events FROM webhooks WHERE id = ? AND account_id = ?")
            .bind(&id)
            .bind(&auth.account_id)
            .fetch_optional(&state.db)
            .await?;
    let (url, events) = row.ok_or_else(|| ApiError::not_found(format!("webhook {id}")))?;

    let secret = gen_secret();
    let prefix: String = secret.chars().take(6).collect();
    let last_four: String = secret.chars().skip(secret.len() - 4).collect();
    let secret_hash = crate::auth::hash_secret(&secret)?;
    let now = now_ts();
    sqlx::query(
        "UPDATE webhooks SET secret_hash = ?, secret = ?, prefix = ?, last_four = ?, \
         updated_at = ? WHERE id = ? AND account_id = ?",
    )
    .bind(&secret_hash)
    .bind(&secret)
    .bind(&prefix)
    .bind(&last_four)
    .bind(&now)
    .bind(&id)
    .bind(&auth.account_id)
    .execute(&state.db)
    .await?;

    Ok(Json(WebhookRotated {
        webhook: WebhookCreated {
            id,
            url,
            events,
            prefix,
            last_four,
            secret,
            created_at: now,
        },
    }))
}

pub async fn remove_webhook(
    State(state): State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let res = sqlx::query("DELETE FROM webhooks WHERE id = ? AND account_id = ?")
        .bind(&id)
        .bind(&auth.account_id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("webhook {id}")));
    }
    Ok(Json(serde_json::json!({})))
}

/// Set to `1` to allow webhook targets on private/loopback addresses.
///
/// Off by default. A webhook URL is attacker-controlled input that this server
/// then fetches, and this server runs next to the hypervisor API — a target of
/// `http://127.0.0.1:8006` would turn the control plane into a proxy for its
/// own Proxmox API. But a self-hosted deployment may legitimately want to post
/// to something on its own network, so it is an explicit opt-in rather than a
/// hard ban.
const ALLOW_PRIVATE_ENV: &str = "ORI_WEBHOOK_ALLOW_PRIVATE";

/// Whether an address is safe to fetch from here.
///
/// Conservative by construction: anything not clearly a public unicast address
/// is refused. Rejecting a legitimate target is a config error the operator can
/// fix; accepting an internal one is an SSRF.
fn is_public_unicast(ip: &std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                // 100.64.0.0/10 carrier-grade NAT
                || (o[0] == 100 && (64..128).contains(&o[1]))
                // 192.0.0.0/24 IETF protocol assignments
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                // 198.18.0.0/15 benchmarking
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19)))
        }
        IpAddr::V6(v6) => {
            // An IPv4-mapped address is an IPv4 address wearing a hat.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_unicast(&IpAddr::V4(v4));
            }
            let seg = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // fe80::/10 link-local
                || (seg[0] & 0xffc0) == 0xfe80
                // fc00::/7 unique local
                || (seg[0] & 0xfe00) == 0xfc00)
        }
    }
}

/// Parse a webhook URL and refuse anything we should not fetch.
///
/// **Every** resolved address must be public: a hostname with one public and
/// one loopback answer is a bypass, not a partial pass.
async fn validate_url_async(url: &str, allow_private: bool) -> ApiResult<()> {
    let parsed = url::Url::parse(url)
        .map_err(|e| ApiError::invalid_request(format!("webhook url is not a url: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ApiError::invalid_request(format!(
            "webhook url must be http(s)://, got {:?}",
            parsed.scheme()
        )));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| ApiError::invalid_request("webhook url has no host"))?
        .to_string();
    if allow_private {
        tracing::warn!(
            host = %host,
            "{ALLOW_PRIVATE_ENV} is set: webhook targets on private addresses are permitted"
        );
        return Ok(());
    }
    let port = parsed.port_or_known_default().unwrap_or(80);
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| ApiError::invalid_request(format!("cannot resolve {host}: {e}")))?
        .collect();
    if addrs.is_empty() {
        return Err(ApiError::invalid_request(format!(
            "{host} resolved to no addresses"
        )));
    }
    for a in &addrs {
        if !is_public_unicast(&a.ip()) {
            return Err(ApiError::invalid_request(format!(
                "webhook target {host} resolves to {} which is not a public address; \
                 set {ALLOW_PRIVATE_ENV}=1 to allow internal targets",
                a.ip()
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// delivery engine
// ---------------------------------------------------------------------------

/// Enqueue one delivery row per webhook subscribed to `event` and kick the
/// first attempt off the request path. Best-effort by design: a webhook
/// failure must never break the sandbox lifecycle, so every error is logged
/// and swallowed. The only work done on the caller's path is a SELECT plus a
/// handful of INSERTs — the HTTP POST happens in a spawned task.
pub async fn emit(state: &AppState, sandbox_id: &str, event: &str) {
    let Ok(Some(sandbox)) = crate::repo::get_sandbox_including_deleted(&state.db, sandbox_id).await
    else {
        return;
    };
    let payload = payload_for(&sandbox, event);
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM webhooks WHERE account_id = ? AND (',' || events || ',') LIKE ?",
    )
    .bind(&sandbox.account_id)
    .bind(format!("%,{event},%"))
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    for (webhook_id,) in ids {
        let delivery_id = gen_id("oriwd_");
        let now = now_ts();
        if let Err(e) = sqlx::query(
            "INSERT INTO webhook_deliveries (id, webhook_id, event, payload, attempts, \
             max_attempts, status, next_attempt_at, created_at) \
             VALUES (?, ?, ?, ?, 0, ?, 'pending', NULL, ?)",
        )
        .bind(&delivery_id)
        .bind(&webhook_id)
        .bind(event)
        .bind(&payload)
        .bind(MAX_ATTEMPTS)
        .bind(&now)
        .execute(&state.db)
        .await
        {
            tracing::warn!(delivery = %delivery_id, error = %e, "webhook enqueue failed");
            continue;
        }
        // First attempt runs immediately in its own task; retries are
        // scheduled by the sweeper via `next_attempt_at`.
        let state2 = state.clone();
        tokio::spawn(async move {
            attempt_one(&state2, &delivery_id).await;
        });
    }
}

fn payload_for(sandbox: &SandboxRow, event: &str) -> String {
    serde_json::json!({
        "event": event,
        "id": sandbox.id,
        "name": sandbox.name,
        "state": sandbox.state,
        "url": sandbox.url,
        "team": sandbox.team,
        "occurredAt": now_ts(),
    })
    .to_string()
}

#[derive(sqlx::FromRow)]
struct DeliveryRow {
    id: String,
    event: String,
    payload: String,
    attempts: i64,
    max_attempts: i64,
    secret: String,
    url: String,
}

/// One delivery attempt. The `pending -> processing` claim is guarded in SQL
/// so a concurrent sweeper pass or a stale spawned task cannot double-send.
/// On success the delivery is `delivered`; on failure the attempt count is
/// persisted and either the next retry is scheduled (exponential backoff) or,
/// once the cap is reached, the delivery is `dropped` and recorded as such.
pub async fn attempt_one(state: &AppState, delivery_id: &str) {
    let claimed = sqlx::query(
        "UPDATE webhook_deliveries SET status = 'processing' WHERE id = ? AND status = 'pending'",
    )
    .bind(delivery_id)
    .execute(&state.db)
    .await
    .ok()
    .map(|r| r.rows_affected() > 0)
    .unwrap_or(false);
    if !claimed {
        return;
    }

    let row = sqlx::query_as::<_, DeliveryRow>(
        "SELECT d.id, d.event, d.payload, d.attempts, d.max_attempts, w.secret, w.url \
         FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ?",
    )
    .bind(delivery_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    let Some(row) = row else {
        // webhook was removed while a delivery was pending; retire the row
        let _ = sqlx::query(
            "UPDATE webhook_deliveries SET status = 'dropped', dropped_at = ?, last_error = ? \
             WHERE id = ?",
        )
        .bind(now_ts())
        .bind("webhook removed")
        .bind(delivery_id)
        .execute(&state.db)
        .await;
        return;
    };

    let (ok, err) = deliver(&row, state.config.webhook_allow_private).await;
    let attempts = row.attempts + 1;
    let res = if ok {
        sqlx::query(
            "UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, delivered_at = ?, \
             last_error = NULL, next_attempt_at = NULL WHERE id = ?",
        )
        .bind(attempts)
        .bind(now_ts())
        .bind(delivery_id)
        .execute(&state.db)
        .await
    } else if attempts >= row.max_attempts {
        sqlx::query(
            "UPDATE webhook_deliveries SET status = 'dropped', attempts = ?, last_error = ?, \
             dropped_at = ?, next_attempt_at = NULL WHERE id = ?",
        )
        .bind(attempts)
        .bind(err.as_deref().unwrap_or("delivery failed"))
        .bind(now_ts())
        .bind(delivery_id)
        .execute(&state.db)
        .await
    } else {
        sqlx::query(
            "UPDATE webhook_deliveries SET status = 'pending', attempts = ?, last_error = ?, \
             next_attempt_at = ? WHERE id = ?",
        )
        .bind(attempts)
        .bind(err.as_deref().unwrap_or("delivery failed"))
        .bind(after_seconds(backoff(attempts)))
        .bind(delivery_id)
        .execute(&state.db)
        .await
    };
    if let Err(e) = res {
        tracing::warn!(delivery = %delivery_id, error = %e, "webhook attempt finalise failed");
    }
}

/// Exponential backoff before the *next* attempt, in seconds. `attempts` is
/// 1-based and already incremented, so the delay before attempt N is
/// `base * 2^(N-2)` for N >= 2.
fn backoff(attempts: i64) -> i64 {
    BACKOFF_BASE_SECONDS * 2i64.pow((attempts - 1) as u32)
}

/// Perform one HMAC-signed HTTP POST. The signature covers the timestamp plus
/// the body (`sha256=HMAC(secret, "{ts}.{body}")`), so a replayed request —
/// one with a stale `X-Ori-Timestamp` — no longer verifies unless the attacker
/// can produce a fresh signature, which requires the secret.
async fn deliver(row: &DeliveryRow, allow_private: bool) -> (bool, Option<String>) {
    let ts = chrono::Utc::now().timestamp();
    let msg = format!("{ts}.{}", row.payload);
    let mut mac = HmacSha256::new_from_slice(row.secret.as_bytes()).expect("hmac key is valid");
    mac.update(msg.as_bytes());
    let sig = hex::encode(mac.finalize().into_bytes());

    // Re-validate at delivery time, not just at registration: DNS can change
    // between the two (rebinding), so the check that matters is the one taken
    // immediately before the request.
    if let Err(e) = validate_url_async(&row.url, allow_private).await {
        return (false, Some(format!("refusing to deliver: {e:?}")));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        // A public URL that 302s to 127.0.0.1 is the same attack, so do not
        // follow redirects at all.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok();
    let Some(client) = client else {
        return (false, Some("cannot build http client".into()));
    };
    match client
        .post(&row.url)
        .header("X-Ori-Signature", format!("sha256={sig}"))
        .header("X-Ori-Timestamp", ts.to_string())
        .header("X-Ori-Event", &row.event)
        .header("X-Ori-Delivery-Id", &row.id)
        .header("Content-Type", "application/json")
        .body(row.payload.clone())
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => (true, None),
        Ok(resp) => (
            false,
            Some(format!("endpoint returned HTTP {}", resp.status())),
        ),
        Err(e) => (false, Some(format!("request failed: {e}"))),
    }
}

/// Sweeper pass: reclaim deliveries stranded in `processing` by a crash, then
/// attempt every `pending` delivery whose `next_attempt_at` has passed. Exposed
/// so tests can drive retries deterministically.
pub async fn attempt_due_deliveries(state: &AppState) {
    let stale_before = (chrono::Utc::now() - chrono::Duration::seconds(STALE_PROCESSING_SECS))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let _ = sqlx::query(
        "UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = created_at \
         WHERE status = 'processing' AND created_at < ?",
    )
    .bind(&stale_before)
    .execute(&state.db)
    .await;

    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM webhook_deliveries \
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) \
         ORDER BY created_at LIMIT 200",
    )
    .bind(now_ts())
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    for (id,) in ids {
        attempt_one(state, &id).await;
    }
}

/// Periodic retry loop. The first attempt is spawned from `emit`; this sweeper
/// handles scheduled retries and crash-reclaimed deliveries.
pub fn spawn_sweeper(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(15));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            attempt_due_deliveries(&state).await;
        }
    });
}

#[cfg(test)]
mod ssrf_tests {
    use super::*;
    use std::net::IpAddr;

    /// The addresses that made the scheme-only check exploitable. This server
    /// runs beside the Proxmox API on loopback, so `http://127.0.0.1:8006`
    /// would have made it a proxy for its own hypervisor.
    #[test]
    fn internal_addresses_are_refused() {
        for s in [
            "127.0.0.1", // the hypervisor API lives here
            "::1",
            "0.0.0.0",
            "169.254.169.254", // cloud instance metadata
            "10.0.0.5",
            "172.16.12.65", // this project's own sandbox bridge
            "192.168.1.10",
            "100.64.0.1",       // carrier-grade NAT
            "fe80::1",          // link-local
            "fc00::1",          // unique local
            "::ffff:127.0.0.1", // IPv4-mapped loopback
        ] {
            let ip: IpAddr = s.parse().unwrap();
            assert!(!is_public_unicast(&ip), "{s} must be refused");
        }
    }

    #[test]
    fn public_addresses_are_allowed() {
        for s in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
            let ip: IpAddr = s.parse().unwrap();
            assert!(is_public_unicast(&ip), "{s} must be allowed");
        }
    }

    #[tokio::test]
    async fn loopback_url_is_rejected_at_registration() {
        assert!(validate_url_async("http://127.0.0.1:8006/api2/json", false)
            .await
            .is_err());
        assert!(validate_url_async("ftp://example.com/x", false)
            .await
            .is_err());
        assert!(validate_url_async("not a url", false).await.is_err());
        // The opt-in is what a legitimate internal target needs.
        assert!(validate_url_async("http://127.0.0.1:9/hook", true)
            .await
            .is_ok());
    }
}
