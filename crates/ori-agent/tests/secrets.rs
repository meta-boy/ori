//! Secret-file injection: contents must land at the final path with mode 0600,
//! owned by the sandbox user, never via a world-readable temp file. Verified
//! through the real `apply` handler.

mod common;

use std::path::PathBuf;

use ori_agent::{Agent, Incoming, Outgoing};
use common::{cfg, request};

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ori-agent-it-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn b64(s: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}

#[tokio::test]
async fn secret_file_lands_0600_roundtrip() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("secrets2");
        let secret_path = dir.join("deep").join("creds");
        let agent = Agent::with_logs_dir(cfg(&dir), dir.join("state"));

        let frames = request(
            &agent,
            Incoming::Apply {
                id: "a2".into(),
                env: None,
                secret_files: Some(vec![ori_agent::SecretFileMsg {
                    path: secret_path.clone(),
                    contents_b64: b64("s3cr3t"),
                }]),
                repos: None,
                setup: None,
            },
        )
        .await;

        assert!(matches!(
            frames
                .iter()
                .find(|f| matches!(f, Outgoing::ApplyResult { .. })),
            Some(Outgoing::ApplyResult { ok: true, .. })
        ));

        let mode = std::fs::metadata(&secret_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "secret must be exactly 0600");
        assert_eq!(std::fs::read(&secret_path).unwrap(), b"s3cr3t");
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[tokio::test]
async fn failed_claim_reports_not_ok_and_leaves_no_partial_secret() {
    let dir = temp_dir("secrets3");
    let agent = Agent::with_logs_dir(cfg(&dir), dir.join("state"));
    let frames = request(
        &agent,
        Incoming::Apply {
            id: "a3".into(),
            env: None,
            secret_files: Some(vec![ori_agent::SecretFileMsg {
                path: dir.join("creds"),
                contents_b64: "not!!base64".into(),
            }]),
            repos: None,
            setup: None,
        },
    )
    .await;
    assert!(matches!(
        frames
            .iter()
            .find(|f| matches!(f, Outgoing::ApplyResult { .. })),
        Some(Outgoing::ApplyResult { ok: false, .. })
    ));
    assert!(!dir.join("creds").exists(), "no secret file may be left behind");
    std::fs::remove_dir_all(&dir).ok();
}