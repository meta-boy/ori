//! `--detach` / `--status <pid>` lifecycle: spawn detached, poll running →
//! exited with the right code, and report `lost` for a pid the agent no longer
//! knows (e.g. after a restart).

mod common;

use std::path::PathBuf;
use std::time::Duration;

use ori_agent::{Agent, Incoming, Outgoing};
use common::{cfg, request};

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ori-agent-it-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn spawn_detached(agent: &Agent, cmd: Vec<String>) -> i64 {
    let frames = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(request(
            agent,
            Incoming::Exec {
                id: "d1".into(),
                cmd,
                cwd: None,
                timeout: Some(30),
                env: None,
                detach: Some(true),
            },
        ));
    match frames.iter().find(|f| matches!(f, Outgoing::ExecResult { .. })) {
        Some(Outgoing::ExecResult { pid, detached, completed, .. }) => {
            assert!(*detached, "execResult must say detached");
            assert!(!*completed, "detached exec is not completed yet");
            *pid
        }
        other => panic!("expected detached execResult, got {other:?}"),
    }
}

fn status(agent: &Agent, pid: i64) -> Outgoing {
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(request(agent, Incoming::ExecStatus { id: "s1".into(), pid }))
        .into_iter()
        .find(|f| matches!(f, Outgoing::ExecStatusResult { .. }))
        .expect("expected execStatusResult")
}

#[tokio::test]
async fn detach_then_status_then_lost_lifecycle() {
    let dir = temp_dir("detach");
    let agent = Agent::with_logs_dir(cfg(&dir), dir.join("state"));

    // A job that lives ~1s, writes to stderr, and exits 7.
    let pid = spawn_detached(
        &agent,
        vec![
            "sh".into(),
            "-c".into(),
            "echo before-log >&2; sleep 1; echo done-log >&2; exit 7".into(),
        ],
    );
    assert!(pid > 0);

    // Immediately after spawn it is running.
    match status(&agent, pid) {
        Outgoing::ExecStatusResult { state, exit_code, .. } => {
            assert_eq!(state, "running");
            assert!(exit_code.is_none());
        }
        other => panic!("expected running status, got {other:?}"),
    }

    // The log file appears under the state dir as <pid>.log and shows output.
    let log_path = dir.join("state").join(format!("{pid}.log"));
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let log = loop {
        if log_path.exists() {
            break std::fs::read_to_string(&log_path).unwrap();
        }
        assert!(std::time::Instant::now() < deadline, "log never appeared");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(log.contains("before-log"), "log: {log}");

    // Wait for it to exit with 7; the log tail is surfaced.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match status(&agent, pid) {
            Outgoing::ExecStatusResult { state, exit_code, log_tail } => {
                if state == "exited" {
                    assert_eq!(exit_code, Some(7));
                    let tail = log_tail.unwrap();
                    assert!(tail.contains("done-log"), "tail: {tail}");
                    break;
                }
            }
            other => panic!("unexpected status: {other:?}"),
        }
        assert!(std::time::Instant::now() < deadline, "process never exited");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // A pid the agent has never spawned reports `lost`, not an error.
    match status(&agent, 999_999_999) {
        Outgoing::ExecStatusResult { state, exit_code, log_tail } => {
            assert_eq!(state, "lost");
            assert!(exit_code.is_none());
            assert!(log_tail.is_none());
        }
        other => panic!("expected lost status, got {other:?}"),
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn detached_process_uses_its_own_process_group() {
    let dir = temp_dir("pgroup");
    let agent = Agent::with_logs_dir(cfg(&dir), dir.join("state"));
    let pid = spawn_detached(
        &agent,
        vec![
            "sh".into(),
            "-c".into(),
            "echo pgid=$$; sleep 0.3; echo still-alive >&2".into(),
        ],
    );

    // The child's pid is the leader of its own group (pgid == pid).
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match status(&agent, pid) {
            Outgoing::ExecStatusResult { state, .. } if state == "exited" => break,
            _ => {
                assert!(std::time::Instant::now() < deadline, "never exited");
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        }
    }
    let log = std::fs::read_to_string(dir.join("state").join(format!("{pid}.log"))).unwrap();
    assert!(log.contains("still-alive"), "log: {log}");
    std::fs::remove_dir_all(&dir).ok();
}