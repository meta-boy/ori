//! The outbound tunnel to the control plane.
//!
//! The sandbox dials out over WebSocket (TLS in production); the plane never
//! dials in and the sandbox exposes no inbound listening port. The tunnel
//! reconnects forever with jittered backoff — after a plane restart, a few
//! hundred sandboxes reconnecting at the same instant is a real outage, so the
//! jitter is not decoration.
//!
//! Messages are one JSON object per WebSocket text frame (see `wire`). Requests
//! are handled on spawned tasks so a long-running `exec` does not block other
//! sandbox traffic; responses flow back through a shared channel drained by the
//! single writer half of the socket.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::backoff::Backoff;
use crate::config::Config;
use crate::error::AgentError;
use crate::runtime::Agent;
use crate::wire::{Incoming, Outgoing};

/// A connection that stayed up at least this long counts as healthy; its
/// backoff resets so a later drop reconnects quickly rather than escalating.
const HEALTHY_AFTER: Duration = Duration::from_secs(10);

/// Connect, serve, and reconnect forever. Only returns on unrecoverable config
/// errors; `run` is expected to block for the lifetime of the sandbox.
pub async fn run(cfg: Arc<Config>, agent: Arc<Agent>) -> Result<(), AgentError> {
    let mut backoff = Backoff::default();
    loop {
        let connected_at = Instant::now();
        match serve_once(&cfg, &agent).await {
            Ok(()) => {
                // Clean close (e.g. plane restart while draining). If the
                // connection was healthy for a while, come back promptly.
                if connected_at.elapsed() >= HEALTHY_AFTER {
                    backoff.reset();
                    tokio::time::sleep(Duration::from_millis(150)).await;
                } else {
                    tokio::time::sleep(backoff.next()).await;
                }
            }
            Err(e) => {
                eprintln!("ori agent: tunnel error: {e}; reconnecting");
                tokio::time::sleep(backoff.next()).await;
            }
        }
    }
}

/// Establish one connection and serve requests until it drops.
async fn serve_once(cfg: &Config, agent: &Arc<Agent>) -> Result<(), AgentError> {
    let mut req = cfg
        .control_plane_url
        .as_str()
        .into_client_request()
        .map_err(|e| AgentError::Tunnel(format!("bad tunnel url: {e}")))?;
    req.headers_mut().insert(
        "authorization",
        format!("Bearer {}", cfg.token)
            .parse()
            .map_err(|e| AgentError::Tunnel(format!("bad token: {e}")))?,
    );
    req.headers_mut().insert(
        "x-ori-sandbox",
        cfg.sandbox_id
            .parse()
            .map_err(|e| AgentError::Tunnel(format!("bad sandbox id: {e}")))?,
    );

    let (ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| AgentError::Tunnel(format!("connect {}: {e}", cfg.control_plane_url)))?;

    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::channel::<Outgoing>(256);

    // Announce ourselves on this fresh connection.
    tx.send(Outgoing::Hello {
        sandbox_id: Some(cfg.sandbox_id.clone()),
        hostname: hostname(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
    })
    .await
    .map_err(|e| AgentError::Tunnel(format!("hello channel: {e}")))?;

    // The claim was applied at boot; if the config carried a setup script, run
    // it now that a live tunnel exists to report `setupStatus` over. Idempotent
    // with a later `apply` message that also carries setup.
    agent.start_config_setup(tx.clone()).await;

    loop {
        tokio::select! {
            inbound = stream.next() => {
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<Incoming>(&text) {
                            Ok(req) => {
                                let tx = tx.clone();
                                let agent = agent.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = agent.handle(req, tx.clone()).await {
                                        let _ = tx.send(Outgoing::Error {
                                            id: request_id(&e),
                                            code: "internal".into(),
                                            message: e.to_string(),
                                        }).await;
                                    }
                                });
                            }
                            Err(e) => {
                                eprintln!("ori agent: unparseable request: {e}: {text}");
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        return Ok(());
                    }
                    Some(Ok(_)) => { /* ping/pong/binary: nothing to do */ }
                    Some(Err(e)) => {
                        return Err(AgentError::Tunnel(format!("read: {e}")));
                    }
                    None => {
                        return Ok(());
                    }
                }
            }
            Some(out) = rx.recv() => {
                let text = serde_json::to_string(&out)
                    .map_err(|e| AgentError::Tunnel(format!("encode: {e}")))?;
                if let Err(e) = sink.send(Message::Text(text)).await {
                    return Err(AgentError::Tunnel(format!("write: {e}")));
                }
            }
        }
    }
}

/// Pull the request id out of a `Request` error so the plane can correlate the
/// error frame, if the failure is request-scoped.
fn request_id(e: &AgentError) -> Option<String> {
    match e {
        AgentError::Request { id, .. } => Some(id.clone()),
        _ => None,
    }
}

fn hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    // getaddrinfo-free: read /proc/sys/kernel/hostname on Linux, or fall back
    // to the gethostname call.
    #[cfg(target_os = "linux")]
    {
        if let Ok(h) = std::fs::read_to_string("/proc/sys/kernel/hostname") {
            let h = h.trim();
            if !h.is_empty() {
                return Some(h.to_string());
            }
        }
    }
    #[cfg(unix)]
    {
        if unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0 {
            let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            if len > 0 {
                return Some(String::from_utf8_lossy(&buf[..len]).into_owned());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_id_extracts_from_request_error() {
        let e = AgentError::for_request("r1", AgentError::Other("boom".into()));
        assert_eq!(request_id(&e).as_deref(), Some("r1"));
        assert_eq!(request_id(&AgentError::Other("x".into())), None);
    }

    #[test]
    fn backoff_defaults_are_sane() {
        let b = Backoff::default();
        assert!(b.base_ms() >= 500 && b.base_ms() <= 60_000);
    }
}
