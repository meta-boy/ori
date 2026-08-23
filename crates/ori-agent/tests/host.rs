//! `host <port>`: register a port and report whether anything is listening.
//! Uses the real handler, with a live TCP listener on macOS/Linux and a closed
//! port for the negative case.

mod common;

use std::path::PathBuf;

use common::{cfg, request};
use ori_agent::{Agent, Incoming, Outgoing};

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ori-agent-it-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

async fn host_result(agent: &Agent, port: u16) -> Outgoing {
    request(
        agent,
        Incoming::Host {
            id: "h1".into(),
            port,
            public: None,
        },
    )
    .await
    .json
    .into_iter()
    .find(|f| matches!(f, Outgoing::HostResult { .. }))
    .expect("expected a hostResult frame")
}

#[tokio::test]
async fn reports_listening_when_a_service_is_up() {
    let dir = temp_dir("host-up");
    let agent = Agent::with_logs_dir(cfg(&dir), dir.join("state"));

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    match host_result(&agent, port).await {
        Outgoing::HostResult {
            listening, note, ..
        } => {
            assert!(listening, "port {port} has a live listener: {note:?}");
        }
        other => panic!("expected hostResult, got {other:?}"),
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn reports_nothing_listening_on_a_closed_port() {
    let dir = temp_dir("host-down");
    let agent = Agent::with_logs_dir(cfg(&dir), dir.join("state"));

    // Bind then drop to free the port.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };

    match host_result(&agent, port).await {
        Outgoing::HostResult {
            listening, note, ..
        } => {
            assert!(!listening, "port {port} should be closed: {note:?}");
            let note = note.expect("not-listening must explain itself");
            assert!(note.contains("nothing is listening"), "note: {note}");
        }
        other => panic!("expected hostResult, got {other:?}"),
    }
    std::fs::remove_dir_all(&dir).ok();
}
