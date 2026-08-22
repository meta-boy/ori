//! Shared helpers for `ori-agent` integration tests. These go through the
//! public `Agent::handle` API — the exact path the tunnel uses — so they
//! exercise the real request pipeline (wire frame → handler → result).

use std::path::Path;
use std::time::Duration;

use ori_agent::{Agent, Config, Incoming, Outgoing};
use tokio::sync::mpsc;

/// A minimal config pointed at a throwaway control-plane URL. The tunnel is
/// never dialed in tests; only the handler is exercised.
pub fn cfg(work_dir: &Path) -> Config {
    Config {
        control_plane_url: "ws://127.0.0.1:1".into(),
        token: "test-token".into(),
        sandbox_id: "ori_test".into(),
        work_dir: work_dir.to_path_buf(),
        claim: Default::default(),
    }
}

/// Drive one request through `Agent::handle` and collect every frame it emits.
/// Frames that legitimately arrive after the handler returns (e.g. proactive
/// `setupStatus`) are caught by a short grace poll.
pub async fn request(agent: &Agent, msg: Incoming) -> Vec<Outgoing> {
    let (tx, mut rx) = mpsc::channel(64);
    agent.handle(msg, tx).await.expect("handler must not error");
    let mut out = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Some(frame)) => out.push(frame),
            _ => break,
        }
    }
    out
}

/// Poll `request` until a predicate holds or a deadline passes.
pub async fn request_until(
    agent: &Agent,
    msg: Incoming,
    deadline: tokio::time::Instant,
    mut pred: impl FnMut(&Outgoing) -> bool,
) -> Vec<Outgoing> {
    let (tx, mut rx) = mpsc::channel(64);
    agent.handle(msg, tx).await.expect("handler must not error");
    let mut out = Vec::new();
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(frame)) => {
                if pred(&frame) {
                    out.push(frame);
                    break;
                }
                out.push(frame);
            }
            _ => break,
        }
    }
    out
}

/// Extract the terminal `execResult` from a batch of frames.
pub fn exec_result(frames: &[Outgoing]) -> Option<&Outgoing> {
    frames.iter().find(|f| matches!(f, Outgoing::ExecResult { .. }))
}

/// Extract a `setupStatus` frame from a batch.
pub fn setup_status(frames: &[Outgoing]) -> Option<&Outgoing> {
    frames
        .iter()
        .find(|f| matches!(f, Outgoing::SetupStatus { .. }))
}