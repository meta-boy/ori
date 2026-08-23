//! Secret-file injection: contents must land at the final path with mode 0600,
//! owned by the sandbox user, never via a world-readable temp file. Verified
//! through the real `apply` handler.

mod common;

use std::collections::HashMap;
use std::path::PathBuf;

use common::{cfg, request};
use ori_agent::{Agent, Incoming, Outgoing};

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
                .json
                .iter()
                .find(|f| matches!(f, Outgoing::ApplyResult { .. })),
            Some(Outgoing::ApplyResult { ok: true, .. })
        ));

        let mode = std::fs::metadata(&secret_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
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
            .json
            .iter()
            .find(|f| matches!(f, Outgoing::ApplyResult { .. })),
        Some(Outgoing::ApplyResult { ok: false, .. })
    ));
    assert!(
        !dir.join("creds").exists(),
        "no secret file may be left behind"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// C19: a claim is authoritative. Applying a second claim replaces the first
/// one's env (a var the environment removed is gone from every `exec`), and a
/// secret file the new claim no longer carries is scrubbed from disk — the
/// removal is the point of the upgrade.
#[tokio::test]
async fn re_apply_replaces_env_and_scrubs_removed_secret_files() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("secrets4");
        let keep_path = dir.join("keep");
        let remove_path = dir.join("remove");
        let agent = Agent::with_logs_dir(cfg(&dir), dir.join("state"));

        // first claim: two vars, two files
        let frames = request(
            &agent,
            Incoming::Apply {
                id: "a4".into(),
                env: Some(HashMap::from([
                    ("KEEP".into(), "1".into()),
                    ("DROP".into(), "2".into()),
                ])),
                secret_files: Some(vec![
                    ori_agent::SecretFileMsg {
                        path: keep_path.clone(),
                        contents_b64: b64("keep-secret"),
                    },
                    ori_agent::SecretFileMsg {
                        path: remove_path.clone(),
                        contents_b64: b64("remove-secret"),
                    },
                ]),
                repos: None,
                setup: None,
            },
        )
        .await;
        assert!(matches!(
            frames
                .json
                .iter()
                .find(|f| matches!(f, Outgoing::ApplyResult { .. })),
            Some(Outgoing::ApplyResult { ok: true, .. })
        ));
        assert_eq!(std::fs::read(&keep_path).unwrap(), b"keep-secret");
        assert_eq!(std::fs::read(&remove_path).unwrap(), b"remove-secret");

        // second claim: only one var, one file — the other var and file are
        // gone from the environment
        let frames = request(
            &agent,
            Incoming::Apply {
                id: "a5".into(),
                env: Some(HashMap::from([("KEEP".into(), "new-value".into())])),
                secret_files: Some(vec![ori_agent::SecretFileMsg {
                    path: keep_path.clone(),
                    contents_b64: b64("keep-secret-v2"),
                }]),
                repos: None,
                setup: None,
            },
        )
        .await;
        assert!(matches!(
            frames
                .json
                .iter()
                .find(|f| matches!(f, Outgoing::ApplyResult { .. })),
            Some(Outgoing::ApplyResult { ok: true, .. })
        ));

        // the removed secret file is scrubbed, the kept one is updated
        assert!(
            !remove_path.exists(),
            "removed secret file must be scrubbed from disk"
        );
        assert_eq!(std::fs::read(&keep_path).unwrap(), b"keep-secret-v2");
        let mode = std::fs::metadata(&keep_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        // the replaced env is what future execs see — through the real exec
        // handler, not an internal accessor
        let frames = request(
            &agent,
            Incoming::Exec {
                id: "a6".into(),
                cmd: vec!["sh".into(), "-c".into(), "printf '%s' \"$KEEP\"".into()],
                cwd: None,
                timeout: None,
                env: None,
                detach: Some(false),
            },
        )
        .await;
        let stdout = frames
            .json
            .iter()
            .find_map(|f| match f {
                Outgoing::ExecResult { stdout, .. } => Some(stdout.clone()),
                _ => None,
            })
            .unwrap_or_default();
        assert_eq!(stdout, "new-value", "the upgraded var must be visible");

        let frames = request(
            &agent,
            Incoming::Exec {
                id: "a7".into(),
                cmd: vec!["sh".into(), "-c".into(), "printf '%s' \"$DROP\"".into()],
                cwd: None,
                timeout: None,
                env: None,
                detach: Some(false),
            },
        )
        .await;
        let stdout = frames
            .json
            .iter()
            .find_map(|f| match f {
                Outgoing::ExecResult { stdout, .. } => Some(stdout.clone()),
                _ => None,
            })
            .unwrap_or_default();
        assert_eq!(
            stdout, "",
            "a var the environment removed must be gone from the command env"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
