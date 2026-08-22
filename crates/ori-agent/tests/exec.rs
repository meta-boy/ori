//! `exec` behaviour through the real handler: remote exit-code propagation,
//! timeout enforcement, and `--cwd` resolution against the sandbox work dir.

mod common;

use std::path::PathBuf;
use std::time::Duration;

use ori_agent::{Agent, Incoming, Outgoing};
use common::{cfg, exec_result, request};

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ori-agent-it-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[tokio::test]
async fn propagates_the_remote_exit_code() {
    let dir = temp_dir("exitcode");
    let agent = Agent::with_logs_dir(cfg(&dir), dir.join("state"));
    let frames = request(
        &agent,
        Incoming::Exec {
            id: "r1".into(),
            cmd: vec!["sh".into(), "-c".into(), "exit 42".into()],
            cwd: None,
            timeout: Some(30),
            env: None,
            detach: Some(false),
        },
    )
    .await;
    match exec_result(&frames).unwrap() {
        Outgoing::ExecResult { exit_code, completed, timed_out, .. } => {
            assert!(*completed);
            assert!(!*timed_out);
            assert_eq!(*exit_code, 42);
        }
        other => panic!("expected execResult, got {other:?}"),
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn enforces_timeout_and_reports_124() {
    let dir = temp_dir("timeout");
    let agent = Agent::with_logs_dir(cfg(&dir), dir.join("state"));
    let started = std::time::Instant::now();
    let frames = request(
        &agent,
        Incoming::Exec {
            id: "r2".into(),
            cmd: vec!["sh".into(), "-c".into(), "sleep 30".into()],
            cwd: None,
            timeout: Some(1),
            env: None,
            detach: Some(false),
        },
    )
    .await;
    match exec_result(&frames).unwrap() {
        Outgoing::ExecResult { exit_code, timed_out, completed, .. } => {
            assert!(*timed_out);
            assert_eq!(*exit_code, 124);
            assert!(*completed, "killed-by-timeout is still a completed run");
        }
        other => panic!("expected execResult, got {other:?}"),
    }
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "timeout must not wait out the full sleep"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn resolves_cwd_against_the_work_dir() {
    let dir = temp_dir("cwd");
    let work = dir.join("work");
    std::fs::create_dir_all(work.join("sub")).unwrap();
    let agent = Agent::with_logs_dir(cfg(&work), dir.join("state"));
    let frames = request(
        &agent,
        Incoming::Exec {
            id: "r3".into(),
            cmd: vec!["/bin/pwd".into()],
            cwd: Some("sub".into()),
            timeout: Some(30),
            env: None,
            detach: Some(false),
        },
    )
    .await;
    match exec_result(&frames).unwrap() {
        Outgoing::ExecResult { stdout, exit_code, .. } => {
            assert_eq!(*exit_code, 0);
            let expected = std::fs::canonicalize(work.join("sub"))
                .unwrap_or_else(|_| work.join("sub"))
                .to_string_lossy()
                .into_owned();
            assert_eq!(stdout.trim(), expected);
        }
        other => panic!("expected execResult, got {other:?}"),
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn missing_cwd_is_an_error_not_a_crash() {
    let dir = temp_dir("nocwd");
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let agent = Agent::with_logs_dir(cfg(&work), dir.join("state"));
    let frames = request(
        &agent,
        Incoming::Exec {
            id: "r4".into(),
            cmd: vec!["/bin/true".into()],
            cwd: Some("does-not-exist".into()),
            timeout: Some(30),
            env: None,
            detach: Some(false),
        },
    )
    .await;
    assert!(
        frames
            .iter()
            .any(|f| matches!(f, Outgoing::Error { code, .. } if code == "invalid_request")),
        "expected an invalid_request error frame: {frames:?}"
    );
    std::fs::remove_dir_all(&dir).ok();
}