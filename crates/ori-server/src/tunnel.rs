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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;

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

/// Chunks buffered per inbound stream before the tunnel reader blocks, which
/// applies backpressure to the agent rather than growing without bound.
const STREAM_BUFFER: usize = 16;

/// How long a tunnel request waits before falling back to the provider.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(620);

/// An in-flight request, plus the output streamed for it so far.
///
/// `exec` is not one-reply-per-request: the agent streams stdout/stderr as
/// `stream` frames and only then sends the terminal `execResult`. Resolving on
/// the first frame carrying the id returns an output chunk and silently drops
/// the result, so chunks accumulate here until a terminal frame arrives.
struct Pending {
    tx: oneshot::Sender<Value>,
    stdout: String,
    stderr: String,
}

/// Per-stream inbound sinks, keyed by the stream id the control plane assigned.
type StreamSinks = Arc<Mutex<HashMap<u64, mpsc::Sender<Vec<u8>>>>>;

/// A live agent connection.
#[derive(Clone)]
struct AgentConn {
    tx: mpsc::Sender<Value>,
    /// Outbound binary frames (8-byte LE stream id + payload).
    bin_tx: mpsc::Sender<Vec<u8>>,
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    streams: StreamSinks,
}

/// What the agent reports about a port inside the sandbox.
#[derive(Debug, Clone)]
pub struct PortProbe {
    pub listening: bool,
    pub loopback_only: bool,
    pub note: Option<String>,
}

/// One multiplexed byte stream to a sandbox.
///
/// This is the single primitive behind `host`, `ssh`, `scp` and `forward`: the
/// agent dials the target on loopback *inside* the sandbox, so the control
/// plane needs no route into the sandbox network and the sandbox opens no port.
pub struct TunnelStream {
    id: u64,
    bin_tx: mpsc::Sender<Vec<u8>>,
    tx: mpsc::Sender<Value>,
    rx: mpsc::Receiver<Vec<u8>>,
    streams: StreamSinks,
}

impl TunnelStream {
    /// Bytes toward the sandbox. `false` once the tunnel is gone.
    pub async fn send(&self, bytes: &[u8]) -> bool {
        let mut frame = Vec::with_capacity(8 + bytes.len());
        frame.extend_from_slice(&self.id.to_le_bytes());
        frame.extend_from_slice(bytes);
        self.bin_tx.send(frame).await.is_ok()
    }

    /// Bytes from the sandbox. `None` on clean close or a dropped tunnel.
    pub async fn recv(&mut self) -> Option<Vec<u8>> {
        self.rx.recv().await
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    /// Tell the agent to close, and stop routing to this stream.
    pub async fn close(mut self, code: u16) {
        let _ = self
            .tx
            .send(json!({"type": "streamClose", "id": self.id, "code": code}))
            .await;
        self.streams.lock().await.remove(&self.id);
        self.rx.close();
    }
}

/// Sandbox id -> live tunnel. Cloned into `AppState`.
#[derive(Clone, Default)]
pub struct AgentRegistry {
    inner: Arc<RwLock<HashMap<String, AgentConn>>>,
    next_stream_id: Arc<AtomicU64>,
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
        conn.pending.lock().await.insert(
            id.to_string(),
            Pending {
                tx,
                stdout: String::new(),
                stderr: String::new(),
            },
        );

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

    /// Open a TCP stream to `port` on loopback inside the sandbox.
    ///
    /// `None` means no live tunnel — the caller should report that plainly
    /// rather than handing back a URL or a socket that cannot work.
    pub async fn open_tcp(&self, sandbox_id: &str, port: u16) -> Option<TunnelStream> {
        let conn = { self.inner.read().await.get(sandbox_id).cloned() }?;
        // Stream ids are chosen by the control plane, per the agent contract.
        let id = self.next_stream_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (sink, rx) = mpsc::channel::<Vec<u8>>(STREAM_BUFFER);
        conn.streams.lock().await.insert(id, sink);

        let opened = conn
            .tx
            .send(json!({
                "type": "streamOpen",
                "id": id,
                "kind": {"type": "tcp", "port": port},
            }))
            .await
            .is_ok();
        if !opened {
            conn.streams.lock().await.remove(&id);
            return None;
        }
        Some(TunnelStream {
            id,
            bin_tx: conn.bin_tx.clone(),
            tx: conn.tx.clone(),
            rx,
            streams: conn.streams.clone(),
        })
    }

    /// Ask the agent what is on `port` inside the sandbox.
    ///
    /// Used before handing back a hosted URL: a service bound to `127.0.0.1` is
    /// unreachable through the proxy, and that is the most common mistake with
    /// this feature. Returning the diagnostic beats returning a dead link.
    pub async fn probe_port(&self, sandbox_id: &str, port: u16) -> Option<PortProbe> {
        let id = request_id();
        let frame = json!({"type": "host", "id": id, "port": port});
        let v = self.request(sandbox_id, &id, frame).await?;
        let listening = v
            .get("listening")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let loopback_only = v
            .get("loopbackOnly")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let note = v
            .get("note")
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .or_else(|| {
                if loopback_only {
                    Some(format!(
                        "the service on port {port} is bound to loopback and will not be \
                         reachable through the URL; rebind it to 0.0.0.0"
                    ))
                } else if !listening {
                    Some(format!(
                        "nothing is listening on port {port} in the sandbox"
                    ))
                } else {
                    None
                }
            });
        Some(PortProbe {
            listening,
            loopback_only,
            note,
        })
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
    let (bin_tx, mut bin_rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_BUFFER);
    let pending: Arc<Mutex<HashMap<String, Pending>>> = Default::default();
    let streams: StreamSinks = Default::default();

    state
        .agents
        .insert(
            &sandbox_id,
            AgentConn {
                tx,
                bin_tx,
                pending: pending.clone(),
                streams: streams.clone(),
            },
        )
        .await;
    tracing::info!(sandbox = %sandbox_id, "agent tunnel connected");

    // Outbound: control plane -> agent. Text frames are requests; binary frames
    // are stream payloads, which must not be base64'd into JSON on the hot path.
    let writer = tokio::spawn(async move {
        loop {
            let msg = tokio::select! {
                f = rx.recv() => match f {
                    Some(frame) => match serde_json::to_string(&frame) {
                        Ok(t) => Message::Text(t),
                        Err(e) => {
                            tracing::warn!(error = %e, "agent frame serialise failed");
                            continue;
                        }
                    },
                    None => break,
                },
                b = bin_rx.recv() => match b {
                    Some(bytes) => Message::Binary(bytes),
                    None => break,
                },
            };
            if sink.send(msg).await.is_err() {
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
                if kind == "streamClose" {
                    if let Some(sid) = v.get("id").and_then(|x| x.as_u64()) {
                        // Dropping the sender ends the consumer's `recv()`.
                        streams.lock().await.remove(&sid);
                    }
                    continue;
                }
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
                        let mut guard = pending.lock().await;
                        if kind == "stream" {
                            // An output chunk: accumulate and keep waiting.
                            if let Some(p) = guard.get_mut(id) {
                                let b64 = v.get("data_b64").and_then(|x| x.as_str()).unwrap_or("");
                                if let Ok(bytes) =
                                    base64::engine::general_purpose::STANDARD.decode(b64)
                                {
                                    let text = String::from_utf8_lossy(&bytes);
                                    match v.get("fd").and_then(|x| x.as_u64()).unwrap_or(1) {
                                        2 => p.stderr.push_str(&text),
                                        _ => p.stdout.push_str(&text),
                                    }
                                }
                            }
                            continue;
                        }
                        match guard.remove(id) {
                            Some(p) => {
                                let mut frame = v;
                                // `stdout`/`stderr` are omitted from the terminal
                                // frame when empty, so fold in what we streamed.
                                if frame
                                    .get("stdout")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .is_empty()
                                    && !p.stdout.is_empty()
                                {
                                    frame["stdout"] = Value::String(p.stdout);
                                }
                                if frame
                                    .get("stderr")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .is_empty()
                                    && !p.stderr.is_empty()
                                {
                                    frame["stderr"] = Value::String(p.stderr);
                                }
                                let _ = p.tx.send(frame);
                            }
                            None => {
                                tracing::debug!(sandbox = %sandbox_id, kind = %kind, id = %id, "no waiter for frame");
                            }
                        }
                    }
                    None => {
                        tracing::debug!(sandbox = %sandbox_id, kind = %kind, "unsolicited agent frame")
                    }
                }
            }
            Ok(Message::Binary(buf)) => {
                // 8-byte little-endian stream id, then the payload.
                binary_frames += 1;
                if buf.len() < 8 {
                    tracing::warn!(sandbox = %sandbox_id, len = buf.len(), "short stream frame");
                    continue;
                }
                let mut idb = [0u8; 8];
                idb.copy_from_slice(&buf[..8]);
                let sid = u64::from_le_bytes(idb);
                let sink = { streams.lock().await.get(&sid).cloned() };
                match sink {
                    // `send` awaits when the consumer is behind, which stops us
                    // reading the socket and pushes backpressure to the agent
                    // rather than buffering without bound.
                    Some(s) => {
                        if s.send(buf[8..].to_vec()).await.is_err() {
                            streams.lock().await.remove(&sid);
                        }
                    }
                    None => tracing::debug!(
                        sandbox = %sandbox_id,
                        stream = sid,
                        "stream data for an unknown stream"
                    ),
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }

    state.agents.remove(&sandbox_id).await;
    // Ending every stream is what lets an in-flight proxy or ssh session see
    // the disconnect instead of hanging on a channel nobody will feed again.
    streams.lock().await.clear();
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

    /// Pinned against the **actual** serialized frame, captured from
    /// `ori-agent`'s own serializer (see its `exec_result_wire_keys` test), not
    /// from an assumption about how serde renames fields.
    ///
    /// An earlier version of this test asserted the opposite — that these keys
    /// were snake_case — and passed, because the fixture was hand-written from
    /// the same wrong belief as the code under test. A fixture you author
    /// yourself cannot verify a contract you do not own.
    #[test]
    fn exec_result_frame_keys_are_camel_case() {
        let frame: Value = serde_json::from_str(
            r#"{"type":"execResult","id":"req_1","pid":42,"completed":true,
                "exitCode":7,"durationMs":19,"timedOut":false,
                "detached":false,"stdout":"hi\n"}"#,
        )
        .unwrap();
        assert_eq!(frame.get("exitCode").and_then(|v| v.as_i64()), Some(7));
        assert_eq!(frame.get("durationMs").and_then(|v| v.as_i64()), Some(19));
        // `stdout`/`stderr` are omitted when empty, which is why streamed
        // chunks have to be folded into the terminal frame.
        assert!(frame.get("stderr").is_none());
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
