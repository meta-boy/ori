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

use std::time::Duration;

use axum::extract::{Extension, Path, State};
use axum::Json;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Webhook {
    pub id: String,
    pub url: String,
    pub events: String,
    pub prefix: String,
    pub last_four: String,
    pub created_at: String,
    pub state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookList {
    pub webhooks: Vec<Webhook>,
}

/// The secret is present exactly once, on creation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookCreated {
    pub id: String,
    pub url: String,
    pub events: String,
    pub prefix: String,
    pub last_four: String,
    pub secret: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookRotated {
    pub webhook: WebhookCreated,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWebhookRequest {
    pub url: String,
}

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
    validate_url(&req.url)?;
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

fn validate_url(url: &str) -> ApiResult<()> {
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(())
    } else {
        Err(ApiError::invalid_request(format!(
            "webhook url must be http(s)://, got {url:?}"
        )))
    }
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

    let (ok, err) = deliver(&row).await;
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
async fn deliver(row: &DeliveryRow) -> (bool, Option<String>) {
    let ts = chrono::Utc::now().timestamp();
    let msg = format!("{ts}.{}", row.payload);
    let mut mac = HmacSha256::new_from_slice(row.secret.as_bytes()).expect("hmac key is valid");
    mac.update(msg.as_bytes());
    let sig = hex::encode(mac.finalize().into_bytes());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
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
