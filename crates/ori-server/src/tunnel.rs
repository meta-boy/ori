//! The agent tunnel: the sandbox dials the control plane, never the reverse.
//!
//! `crates/ori-agent` was complete and unreachable for most of this project's
//! life because nothing here accepted its WebSocket (see
//! `docs/DIVERGENCES.md`). This module is that endpoint.
//!
//! The agent's side of the contract is fixed and documented in
//! `crates/ori-agent/src/wire.rs`; this speaks it rather than redefining it:
//!
//! - connects with `Authorization: Bearer <agent_token>` and `x-ori-sandbox`
//! - immediately sends `{"type":"hello",...}`
//! - request/response frames are JSON text, correlated by an `id` field
//! - `streamData` is a **binary** frame: 8-byte little-endian stream id
//!   followed by the chunk bytes
//!
//! Frames are handled as `serde_json::Value` on purpose. Depending on
//! `ori-agent` from the server would invert the dependency (and drag the
//! guest agent's process-management deps into the control plane), while
//! restating its enums here would recreate exactly the duplication that
//! already caused one outage.
//!
//! **Scope of this pass:** request/response frames, which is what `exec`
//! needs. Binary stream frames are accepted and counted but not yet routed —
//! `ssh`/`scp`/`forward` need a stream router, and that lands with those
//! commands. Unrouted frames are logged rather than dropped in silence,
//! because a silent no-op is how the pool sat empty for 110 seconds.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Outbound frames buffered per agent before the sender blocks. Bounded so a
/// wedged agent applies backpressure instead of growing without limit.
const OUTBOUND_BUFFER: usize = 64;

/// How long a tunnel request waits before falling back to the provider.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(620);

/// A live agent connection.
#[derive(Clone)]
struct AgentConn {
    tx: mpsc::Sender<Value>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
}

/// Sandbox id -> live tunnel. Cloned into `AppState`.
#[derive(Clone, Default)]
pub struct AgentRegistry {
    inner: Arc<RwLock<HashMap<String, AgentConn>>>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn is_connected(&self, sandbox_id: &str) -> bool {
        self.inner.read().await.contains_key(sandbox_id)
    }

    pub async fn connected_count(&self) -> usize {
        self.inner.read().await.len()
    }

    /// Send a frame and await the reply carrying the same `id`.
    ///
    /// `None` means "not reachable this way" — no tunnel, the send failed, or
    /// the agent went away mid-request. Every `None` is a signal to fall back
    /// to the provider, never an error to surface.
    async fn request(&self, sandbox_id: &str, id: &str, frame: Value) -> Option<Value> {
        let conn = { self.inner.read().await.get(sandbox_id).cloned() }?;
        let (tx, rx) = oneshot::channel();
        conn.pending.lock().await.insert(id.to_string(), tx);

        if conn.tx.send(frame).await.is_err() {
            conn.pending.lock().await.remove(id);
            return None;
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(v)) => Some(v),
            _ => {
                conn.pending.lock().await.remove(id);
                None
            }
        }
    }

    /// Run a command in the sandbox over the tunnel.
    ///
    /// Returns the agent's `execResult` frame, or `None` if the sandbox has no
    /// live tunnel — the caller then uses the provider's `exec`.
    #[allow(clippy::too_many_arguments)]
    pub async fn exec(
        &self,
        sandbox_id: &str,
        cmd: &[String],
        cwd: Option<&str>,
        timeout_secs: Option<u64>,
        detach: bool,
    ) -> Option<Value> {
        let id = request_id();
        let frame = json!({
            "type": "exec",
            "id": id,
            "cmd": cmd,
            "cwd": cwd,
            "timeout": timeout_secs,
            "detach": detach,
        });
        self.request(sandbox_id, &id, frame).await
    }

    async fn insert(&self, sandbox_id: &str, conn: AgentConn) {
        // A reconnect replaces the previous entry; the old task is already
        // finished or about to be, and its pending requests will time out
        // rather than being answered by the new connection.
        self.inner
            .write()
            .await
            .insert(sandbox_id.to_string(), conn);
    }

    async fn remove(&self, sandbox_id: &str) {
        self.inner.write().await.remove(sandbox_id);
    }
}

/// 128 bits of CSPRNG hex. Used for both request ids and agent tokens.
fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("csprng");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn request_id() -> String {
    format!("req_{}", random_hex(8))
}

/// Mint a token for a sandbox's agent. Stored on the sandbox row and written
/// into the sandbox's agent config at claim time.
pub fn new_agent_token() -> String {
    format!("orit_{}", random_hex(24))
}

/// Constant-time compare, so a wrong token cannot be recovered by timing.
fn secret_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `GET /api/v1/agent/tunnel` — WebSocket upgrade for a sandbox's agent.
///
/// Lives outside the account-key middleware: an agent authenticates with its
/// own per-sandbox token, which is not an account credential.
pub async fn agent_tunnel(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    let sandbox_id = headers
        .get("x-ori-sandbox")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(ApiError::unauthorized)?;

    let presented = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        })
        .map(str::to_string)
        .ok_or_else(ApiError::unauthorized)?;

    let stored: Option<(Option<String>,)> =
        sqlx::query_as("SELECT agent_token FROM sandboxes WHERE id = ?")
            .bind(&sandbox_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| ApiError::internal(format!("agent token lookup: {e}")))?;

    let expected = stored
        .and_then(|(t,)| t)
        .ok_or_else(ApiError::unauthorized)?;

    if !secret_eq(&presented, &expected) {
        return Err(ApiError::unauthorized());
    }

    Ok(ws.on_upgrade(move |socket| serve(state, sandbox_id, socket)))
}

/// Serve one agent connection until it drops.
async fn serve(state: AppState, sandbox_id: String, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Value>(OUTBOUND_BUFFER);
    let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> = Default::default();

    state
        .agents
        .insert(
            &sandbox_id,
            AgentConn {
                tx,
                pending: pending.clone(),
            },
        )
        .await;
    tracing::info!(sandbox = %sandbox_id, "agent tunnel connected");

    // Outbound: control plane -> agent.
    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let text = match serde_json::to_string(&frame) {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!(error = %e, "agent frame serialise failed");
                    continue;
                }
            };
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // Inbound: agent -> control plane.
    let mut binary_frames = 0u64;
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let Ok(v) = serde_json::from_str::<Value>(&text) else {
                    tracing::warn!(sandbox = %sandbox_id, "agent sent unparseable frame");
                    continue;
                };
                let kind = v
                    .get("type")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if kind == "hello" {
                    let version = v
                        .get("version")
                        .and_then(|x| x.as_str())
                        .unwrap_or("?")
                        .to_string();
                    tracing::info!(sandbox = %sandbox_id, version = %version, "agent hello");
                    continue;
                }
                // Correlate by id; an uncorrelated frame is logged, never dropped
                // silently.
                match v.get("id").and_then(|x| x.as_str()) {
                    Some(id) => {
                        if let Some(waiter) = pending.lock().await.remove(id) {
                            let _ = waiter.send(v);
                        } else {
                            tracing::debug!(sandbox = %sandbox_id, kind = %kind, id = %id, "no waiter for frame");
                        }
                    }
                    None => {
                        tracing::debug!(sandbox = %sandbox_id, kind = %kind, "unsolicited agent frame")
                    }
                }
            }
            Ok(Message::Binary(_)) => {
                // Stream frames land here. Routing arrives with ssh/scp/forward;
                // until then, count them so an unrouted stream is visible.
                binary_frames += 1;
                if binary_frames == 1 {
                    tracing::warn!(
                        sandbox = %sandbox_id,
                        "agent sent stream data but no stream router is wired yet"
                    );
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }

    state.agents.remove(&sandbox_id).await;
    writer.abort();
    tracing::info!(sandbox = %sandbox_id, binary_frames, "agent tunnel disconnected");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_eq_matches_only_identical_tokens() {
        assert!(secret_eq("orit_abc", "orit_abc"));
        assert!(!secret_eq("orit_abc", "orit_abd"));
        assert!(!secret_eq("orit_abc", "orit_abcd"));
        assert!(!secret_eq("", "x"));
    }

    #[test]
    fn tokens_are_distinct_and_prefixed() {
        let a = new_agent_token();
        let b = new_agent_token();
        assert_ne!(a, b, "tokens must not repeat");
        assert!(a.starts_with("orit_"));
        assert_eq!(a.len(), "orit_".len() + 48);
    }

    /// The agent's frame enums carry `#[serde(tag = "type", rename_all =
    /// "camelCase")]`, which renames **variants** and leaves struct fields
    /// snake_case. Reading `exitCode` instead of `exit_code` silently yields
    /// defaults — a successful command reported as exit -1 with no output.
    /// That is the same failure as the `memoryGb`/`memoryGB` outage, so the
    /// literal frame is pinned here rather than trusted to memory.
    #[test]
    fn exec_result_frame_uses_snake_case_fields() {
        let frame: Value = serde_json::from_str(
            r#"{"type":"execResult","id":"req_1","pid":42,"completed":true,
                "exit_code":0,"duration_ms":17,"timed_out":false,
                "detached":false,"stdout":"hi\n","stderr":""}"#,
        )
        .unwrap();
        assert_eq!(frame.get("exit_code").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(frame.get("duration_ms").and_then(|v| v.as_i64()), Some(17));
        assert!(
            frame.get("exitCode").is_none(),
            "camelCase would mean the agent contract changed; update the reader too"
        );
        assert!(frame.get("durationMs").is_none());
    }

    #[tokio::test]
    async fn request_returns_none_without_a_tunnel() {
        let reg = AgentRegistry::new();
        assert!(!reg.is_connected("ori_nope").await);
        assert_eq!(reg.connected_count().await, 0);
        let out = reg
            .exec("ori_nope", &["true".to_string()], None, None, false)
            .await;
        assert!(out.is_none(), "no tunnel must fall back, not error");
    }
}
