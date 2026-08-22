//! Setup script: run the `--setup-file` payload (max 64 KiB) in the background
//! after the sandbox reports ready, and report `setupStatus`
//! (`pending|running|done|failed`) + `setupError` to the control plane.
//!
//! Status changes are pushed as `setupStatus` frames; the plane maps them onto
//! the sandbox's `setupStatus`/`setupError` fields. A failed script reports the
//! tail of its stderr as `setupError` so the user can fix it without digging
//! through logs.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tokio::sync::mpsc;

use crate::config::SetupSpec;
use crate::error::AgentError;
use crate::wire::{decode_b64, Outgoing, SETUP_SCRIPT_MAX_BYTES};

/// `setupStatus` values, mirroring `docs/SPEC-API.md`.
pub const STATUS_PENDING: &str = "pending";
pub const STATUS_RUNNING: &str = "running";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FAILED: &str = "failed";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupState {
    Pending,
    Running,
    Done,
    Failed(String),
}

impl SetupState {
    pub fn status(&self) -> &'static str {
        match self {
            SetupState::Pending => STATUS_PENDING,
            SetupState::Running => STATUS_RUNNING,
            SetupState::Done => STATUS_DONE,
            SetupState::Failed(_) => STATUS_FAILED,
        }
    }

    pub fn error(&self) -> Option<&str> {
        match self {
            SetupState::Failed(e) => Some(e),
            _ => None,
        }
    }
}

/// Tracks and runs the setup script.
pub struct SetupRunner {
    spec: Option<SetupSpec>,
    state: Mutex<SetupState>,
    started: AtomicBool,
}

impl SetupRunner {
    pub fn new(spec: Option<SetupSpec>) -> Self {
        let state = if spec.is_some() {
            SetupState::Pending
        } else {
            // No script: a status read reports a neutral state; the runner
            // simply never fires.
            SetupState::Pending
        };
        Self {
            spec,
            state: Mutex::new(state),
            started: AtomicBool::new(false),
        }
    }

    /// Whether a setup script was supplied with the claim.
    pub fn has_script(&self) -> bool {
        self.spec.is_some()
    }

    pub fn state(&self) -> SetupState {
        self.state.lock().unwrap().clone()
    }

    fn set_state(&self, s: SetupState) {
        *self.state.lock().unwrap() = s;
    }

    /// Start the script in the background, reporting transitions over `tx`.
    /// No-op when there is no script or it already started.
    pub async fn start(&self, logs_dir: &Path, tx: mpsc::Sender<Outgoing>) {
        let Some(spec) = self.spec.clone() else {
            return;
        };
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }

        let script_path = match self.materialize_script(&spec, logs_dir) {
            Ok(p) => p,
            Err(e) => {
                self.set_state(SetupState::Failed(e.to_string()));
                let _ = tx
                    .send(Outgoing::SetupStatus {
                        status: STATUS_FAILED.into(),
                        error: Some(e.to_string()),
                    })
                    .await;
                return;
            }
        };

        let state_clone = self.state.clone();
        let tx_clone = tx.clone();
        let logs_dir = logs_dir.to_path_buf();
        tokio::spawn(async move {
            let _ = tx
                .send(Outgoing::SetupStatus {
                    status: STATUS_RUNNING.into(),
                    error: None,
                })
                .await;

            let log_path = logs_dir.join("setup.log");
            let outcome = run_script(&script_path, &log_path).await;
            let new_state = if outcome.exit_code == 0 {
                SetupState::Done
            } else {
                let err = outcome.log_tail.trim().chars().take(2048).collect::<String>();
                let err = if err.is_empty() {
                    format!("setup script exited with {}", outcome.exit_code)
                } else {
                    err.to_string()
                };
                SetupState::Failed(err)
            };

            *state_clone.lock().unwrap() = new_state.clone();
            let (status, error) = (new_state.status().to_string(), new_state.error().map(String::from));
            let _ = tx_clone
                .send(Outgoing::SetupStatus { status, error })
                .await;
        });
    }

    /// Materialize the inline script payload (validated ≤ 64 KiB) to a private
    /// file, or return the path-based script as-is.
    fn materialize_script(&self, spec: &SetupSpec, logs_dir: &Path) -> Result<PathBuf, AgentError> {
        if let Some(path) = &spec.path {
            if path.is_file() {
                return Ok(path.clone());
            }
            return Err(AgentError::Config(format!(
                "setup script path does not exist: {}",
                path.display()
            )));
        }
        if let Some(b64) = &spec.script_b64 {
            let bytes = decode_b64(b64)?;
            if bytes.len() > SETUP_SCRIPT_MAX_BYTES {
                return Err(AgentError::Config(format!(
                    "setup script payload is {} bytes; the cap is {SETUP_SCRIPT_MAX_BYTES}",
                    bytes.len()
                )));
            }
            std::fs::create_dir_all(logs_dir)?;
            let path = logs_dir.join("setup.sh");
            let mut opts = std::fs::OpenOptions::new();
            opts.create(true).write(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            use std::io::Write;
            let mut f = opts.open(&path)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            }
            return Ok(path);
        }
        Err(AgentError::Config(
            "setup spec has neither scriptB64 nor path".into(),
        ))
    }
}

/// Outcome of running the setup script.
struct ScriptOutcome {
    exit_code: i32,
    /// Tail of the script log, used as `setupError` on failure.
    log_tail: String,
}

/// Run a script with `sh`, appending stdout+stderr to `log_path` (0600) and
/// capturing a tail of it for error reporting.
async fn run_script(path: &Path, log_path: &Path) -> ScriptOutcome {
    let log = open_append_0600(log_path);
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg(path)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);

    match log {
        Ok(f) => {
            let err = f.try_clone().unwrap_or_else(|_| {
                std::fs::OpenOptions::new().open(log_path).ok()
            });
            let err_handle = err.ok();
            cmd.stdout(std::process::Stdio::from(f));
            if let Some(e) = err_handle {
                cmd.stderr(std::process::Stdio::from(e));
            } else {
                cmd.stderr(std::process::Stdio::null());
            }
        }
        Err(_) => {
            cmd.stdout(std::process::Stdio::null());
            cmd.stderr(std::process::Stdio::null());
        }
    }

    let status = cmd.status().await;
    let exit_code = match status {
        Ok(s) => crate::exec::exit_code_of(s),
        Err(_) => 1,
    };
    let log_tail = crate::processes::tail_file(log_path, 2048).unwrap_or_default();
    ScriptOutcome { exit_code, log_tail }
}

#[cfg(unix)]
fn open_append_0600(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?;
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    Ok(f)
}

#[cfg(not(unix))]
fn open_append_0600(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().create(true).append(true).open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(script: &str) -> SetupSpec {
        SetupSpec {
            script_b64: Some(base64::engine::general_purpose::STANDARD.encode(script.as_bytes())),
            path: None,
        }
    }

    #[tokio::test]
    async fn reports_done_on_success() {
        let dir = std::env::temp_dir().join(format!("ori-agent-setup-ok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, _rx) = mpsc::channel(16);
        let runner = SetupRunner::new(Some(spec("echo setup ran")));
        runner.start(&dir, tx).await;
        // Give the background task a moment.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(runner.state(), SetupState::Done);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn reports_failed_with_error_from_log_tail() {
        let dir = std::env::temp_dir().join(format!("ori-agent-setup-fail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, mut rx) = mpsc::channel(16);
        let runner = SetupRunner::new(Some(spec("echo boom >&2; exit 3")));
        runner.start(&dir, tx).await;
        let mut saw = None;
        while let Some(msg) = rx.recv().await {
            if let Outgoing::SetupStatus { status, error } = msg {
                if status == STATUS_FAILED {
                    saw = error;
                    break;
                }
            }
        }
        let err = saw.expect("failed status must carry an error");
        assert!(err.contains("boom") || err.contains("exit"), "got: {err}");
        assert!(matches!(runner.state(), SetupState::Failed(_)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn starts_only_once() {
        let dir = std::env::temp_dir().join(format!("ori-agent-setup-once-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, _rx) = mpsc::channel(16);
        let runner = SetupRunner::new(Some(spec("echo hi")));
        runner.start(&dir, tx.clone()).await;
        runner.start(&dir, tx).await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(runner.state(), SetupState::Done);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn rejects_script_over_64k_at_start() {
        let dir = std::env::temp_dir().join(format!("ori-agent-setup-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let big = "a".repeat(65 * 1024);
        let (tx, mut rx) = mpsc::channel(16);
        let runner = SetupRunner::new(Some(spec(&big)));
        runner.start(&dir, tx).await;
        let mut saw = None;
        while let Some(msg) = rx.recv().await {
            if let Outgoing::SetupStatus { status, error } = msg {
                if status == STATUS_FAILED {
                    saw = error;
                    break;
                }
            }
        }
        let err = saw.expect("oversized script must report failed");
        assert!(err.contains("64"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }
}