//! Setup script: run the ≤ 64 KiB payload in the background after the claim
//! applies, reporting `setupStatus` (`running` → `done`/`failed`) with
//! `setupError` on failure.

mod common;

use std::path::PathBuf;
use std::time::Duration;

use ori_agent::{Agent, Config, Incoming, Outgoing};
use common::{cfg, request_until};

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ori-agent-it-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn b64(s: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}

fn cfg_with_setup(work_dir: &std::path::Path, script: &str) -> Config {
    let mut c = cfg(work_dir);
    c.claim.setup = Some(ori_agent::SetupSpec {
        script_b64: Some(b64(script)),
        path: None,
    });
    c
}

async fn apply_with_setup(c: Config) -> Vec<Outgoing> {
    let dir = c.work_dir.clone();
    let agent = Agent::with_logs_dir(c, dir.join("state"));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    request_until(
        &agent,
        Incoming::Apply {
            id: "s1".into(),
            env: None,
            secret_files: None,
            repos: None,
            setup: None,
        },
        deadline,
        |f| matches!(f, Outgoing::SetupStatus { status, .. } if status == "done" || status == "failed"),
    )
    .await
}

#[tokio::test]
async fn setup_script_reports_done() {
    let dir = temp_dir("setup-done");
    let frames = apply_with_setup(cfg_with_setup(&dir, "echo setup ran; exit 0")).await;
    let done = frames
        .iter()
        .find(|f| matches!(f, Outgoing::SetupStatus { status, .. } if status == "done"));
    assert!(done.is_some(), "expected a done setupStatus: {frames:?}");
    assert!(
        frames.iter().any(|f| matches!(f, Outgoing::SetupStatus { status, .. } if status == "running")),
        "running must precede done"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn setup_script_failure_reports_error() {
    let dir = temp_dir("setup-fail");
    let frames = apply_with_setup(cfg_with_setup(&dir, "echo boom >&2; exit 3")).await;
    let failed = frames
        .iter()
        .find(|f| matches!(f, Outgoing::SetupStatus { status, .. } if status == "failed"));
    match failed {
        Some(Outgoing::SetupStatus { error, .. }) => {
            let err = error.as_ref().expect("failed setup must carry an error");
            assert!(err.contains("boom") || err.contains("exit"), "err: {err}");
        }
        other => panic!("expected failed setupStatus: {other:?}"),
    }
    std::fs::remove_dir_all(&dir).ok();
}