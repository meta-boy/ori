//! The agent runtime: owns the sandbox-side state (injected env, detached
//! process registry, setup runner) and answers control-plane requests.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;

use crate::config::Config;
use crate::error::AgentError;
use crate::host;
use crate::processes::{self, DetachedProc, ProcState, ProcStatus, Registry};
use crate::setup::{SetupRunner, SetupState};
use crate::wire::{
    Incoming, Outgoing, EXEC_TIMEOUT_DEFAULT_SECS, EXEC_TIMEOUT_MAX_SECS, EXEC_TIMEOUT_MIN_SECS,
};

/// Where detached-process logs and the setup log live: `~/.ori/processes`.
pub fn logs_dir() -> PathBuf {
    crate::config::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".ori")
        .join("processes")
}

/// Sandbox-side runtime state shared across request handlers and tunnel
/// connections.
pub struct Agent {
    pub cfg: Config,
    claim_env: Mutex<HashMap<String, String>>,
    registry: Arc<Mutex<Registry>>,
    setup: SetupRunner,
    logs_dir: PathBuf,
}

impl Agent {
    pub fn new(cfg: Config) -> Self {
        let logs_dir = logs_dir();
        let _ = std::fs::create_dir_all(&logs_dir);
        let setup = SetupRunner::new(cfg.claim.setup.clone());
        Self {
            cfg,
            claim_env: Mutex::new(HashMap::new()),
            registry: Arc::new(Mutex::new(Registry::new())),
            setup,
            logs_dir,
        }
    }

    /// Construct with an explicit state/log directory instead of `~/.ori`.
    /// Used by tests and by sandbox images that keep the agent state under a
    /// different root.
    pub fn with_logs_dir(cfg: Config, logs_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&logs_dir);
        let setup = SetupRunner::new(cfg.claim.setup.clone());
        Self {
            cfg,
            claim_env: Mutex::new(HashMap::new()),
            registry: Arc::new(Mutex::new(Registry::new())),
            setup,
            logs_dir,
        }
    }

    /// The sandbox work dir, as configured.
    pub fn work_dir(&self) -> PathBuf {
        self.cfg.work_dir()
    }

    /// Apply a claim payload (env vars, secret files, repo checkouts) from the
    /// config at boot. Commits the claim env only on full success so a failed
    /// claim does not half-apply.
    pub async fn apply_claim(&self, claim: &crate::config::Claim) -> Result<(), AgentError> {
        let mut env_map = self.claim_env.lock().unwrap().clone();
        crate::inject::apply_claim(claim, &mut env_map).await?;
        *self.claim_env.lock().unwrap() = env_map;
        Ok(())
    }

    /// Handle one incoming request, sending any number of frames over `tx`.
    /// Errors are surfaced as `Outgoing::Error` (with the request id) by the
    /// caller; this returns `Ok` for handled requests even when the *remote
    /// command* failed — a non-zero exit code is a result, not a failure.
    pub async fn handle(&self, msg: Incoming, tx: mpsc::Sender<Outgoing>) -> Result<(), AgentError> {
        match msg {
            Incoming::Ping { id } => {
                if let Some(id) = id {
                    tx.send(Outgoing::Ack { id }).await?;
                }
                Ok(())
            }

            Incoming::Apply {
                id,
                env,
                secret_files,
                repos,
                setup,
            } => {
                let claim = crate::config::Claim {
                    env: env.unwrap_or_default(),
                    secret_files: secret_files
                        .unwrap_or_default()
                        .into_iter()
                        .map(|s| crate::config::SecretFile {
                            path: s.path,
                            contents_b64: s.contents_b64,
                        })
                        .collect(),
                    repos: repos
                        .unwrap_or_default()
                        .into_iter()
                        .map(|r| crate::config::RepoRef {
                            url: r.url,
                            r#ref: r.r#ref,
                            path: r.path,
                        })
                        .collect(),
                    setup: setup.map(|s| crate::config::SetupSpec {
                        script_b64: s.script_b64,
                        path: s.path,
                    }),
                };

                let result = self.apply_claim(&claim).await;
                match result {
                    Ok(()) => {
                        // Claim applied → the sandbox is ready; kick off setup.
                        if let Some(spec) = &claim.setup {
                            if let Err(e) = Config::validate_setup(spec) {
                                tx.send(Outgoing::ApplyResult {
                                    id,
                                    ok: true,
                                    error: Some(format!("setup invalid: {e}")),
                                })
                                .await?;
                                return Ok(());
                            }
                        }
                        self.setup.start(&self.logs_dir, tx.clone()).await;
                        tx.send(Outgoing::ApplyResult { id, ok: true, error: None })
                            .await?;
                    }
                    Err(e) => {
                        tx.send(Outgoing::ApplyResult {
                            id,
                            ok: false,
                            error: Some(e.to_string()),
                        })
                        .await?;
                    }
                }
                Ok(())
            }

            Incoming::Exec {
                id,
                cmd,
                cwd,
                timeout,
                env,
                detach,
            } => {
                if cmd.is_empty() {
                    tx.send(Outgoing::Error {
                        id: Some(id.clone()),
                        code: "invalid_request".into(),
                        message: "cmd must not be empty".into(),
                    })
                    .await?;
                    return Ok(());
                }
                let timeout_secs = match validate_timeout(timeout) {
                    Ok(t) => t,
                    Err(e) => {
                        tx.send(Outgoing::Error {
                            id: Some(id.clone()),
                            code: "invalid_request".into(),
                            message: e,
                        })
                        .await?;
                        return Ok(());
                    }
                };

                let workdir = self.cfg.resolve_cwd(cwd.as_deref());
                if !workdir.is_dir() {
                    tx.send(Outgoing::Error {
                        id: Some(id.clone()),
                        code: "invalid_request".into(),
                        message: format!("cwd does not exist: {}", workdir.display()),
                    })
                    .await?;
                    return Ok(());
                }

                let mut command_env = self.command_env();
                if let Some(extra) = env {
                    command_env.extend(extra);
                }

                if detach.unwrap_or(false) {
                    let pid = match self
                        .spawn_detached(&cmd, &command_env, &workdir)
                        .await
                    {
                        Ok(pid) => pid,
                        Err(e) => {
                            tx.send(Outgoing::Error {
                                id: Some(id.clone()),
                                code: "spawn".into(),
                                message: e.to_string(),
                            })
                            .await?;
                            return Ok(());
                        }
                    };
                    tx.send(Outgoing::ExecResult {
                        id,
                        pid: pid as i64,
                        completed: false,
                        exit_code: 0,
                        duration_ms: 0,
                        timed_out: false,
                        detached: true,
                        stdout: String::new(),
                        stderr: String::new(),
                    })
                    .await?;
                    return Ok(());
                }

                self.exec_foreground(&id, &cmd, &workdir, &command_env, timeout_secs, tx)
                    .await?;
                Ok(())
            }

            Incoming::ExecStatus { id, pid } => {
                let status = self.status(pid as i32);
                let (state, exit_code, log_tail) = match status {
                    ProcStatus::Running => ("running", None, self.registry.lock().unwrap().log_tail(pid as i32, processes::LOG_TAIL_MAX_BYTES)),
                    ProcStatus::Exited(code) => ("exited", Some(code), self.registry.lock().unwrap().log_tail(pid as i32, processes::LOG_TAIL_MAX_BYTES)),
                    ProcStatus::Lost => ("lost", None, None),
                };
                tx.send(Outgoing::ExecStatusResult {
                    id,
                    state: state.to_string(),
                    exit_code: exit_code.map(i64::from),
                    log_tail,
                })
                .await?;
                Ok(())
            }

            Incoming::Host { id, port, public: _ } => {
                let probe = host::probe(port).await;
                tx.send(Outgoing::HostResult {
                    id,
                    listening: probe.listening,
                    loopback_only: probe.loopback_only,
                    note: probe.note,
                })
                .await?;
                Ok(())
            }
        }
    }

    /// Environment for every command the agent runs: the agent's inherited
    /// environment, overlaid with the claim-injected env.
    fn command_env(&self) -> HashMap<String, String> {
        let mut env: HashMap<String, String> = std::env::vars().collect();
        env.extend(self.claim_env.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())));
        env
    }

    /// Foreground exec with live streamed output and a terminal result.
    async fn exec_foreground(
        &self,
        id: &str,
        cmd: &[String],
        workdir: &PathBuf,
        env: &HashMap<String, String>,
        timeout: Duration,
        tx: mpsc::Sender<Outgoing>,
    ) -> Result<(), AgentError> {
        let (sout, mut rout) = mpsc::channel::<Vec<u8>>(16);
        let (serr, mut rerr) = mpsc::channel::<Vec<u8>>(16);
        let cmd_owned = cmd.to_vec();
        let wd = workdir.clone();
        let env_owned = env.clone();
        let mut task = tokio::spawn(async move {
            crate::exec::run(&cmd_owned, &wd, &env_owned, timeout, sout, serr).await
        });

        let outcome = loop {
            tokio::select! {
                chunk = rout.recv() => {
                    if let Some(c) = chunk {
                        tx.send(Outgoing::Stream { id: id.to_string(), fd: 1, data_b64: encode(&c) }).await?;
                    }
                }
                chunk = rerr.recv() => {
                    if let Some(c) = chunk {
                        tx.send(Outgoing::Stream { id: id.to_string(), fd: 2, data_b64: encode(&c) }).await?;
                    }
                }
                res = &mut task => {
                    match res {
                        Ok(o) => break o,
                        Err(e) => {
                            tx.send(Outgoing::Error { id: Some(id.to_string()), code: "internal".into(), message: e.to_string() }).await?;
                            return Ok(());
                        }
                    }
                }
            }
        };

        tx.send(Outgoing::ExecResult {
            id: id.to_string(),
            pid: outcome.pid as i64,
            completed: true,
            exit_code: outcome.exit_code as i64,
            duration_ms: outcome.duration.as_millis() as i64,
            timed_out: outcome.timed_out,
            detached: false,
            stdout: String::from_utf8_lossy(&outcome.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&outcome.stderr).into_owned(),
        })
        .await?;
        Ok(())
    }

    /// Spawn a detached process, register it, and install a monitor task that
    /// records its exit state.
    async fn spawn_detached(
        &self,
        cmd: &[String],
        env: &HashMap<String, String>,
        workdir: &Path,
    ) -> Result<i32, AgentError> {
        let (pid, mut child, log_path) =
            processes::spawn_child(cmd, env, workdir, &self.logs_dir).await?;
        {
            let mut reg = self.registry.lock().unwrap();
            reg.insert(DetachedProc {
                pid,
                state: ProcState::Running,
                log_path,
            });
        }
        let registry = self.registry.clone();
        tokio::spawn(async move {
            let code = processes::status_code(child.wait().await);
            if let Ok(mut reg) = registry.lock() {
                reg.record_exit(pid, code);
            }
        });
        Ok(pid)
    }

    fn status(&self, pid: i32) -> ProcStatus {
        self.registry.lock().unwrap().status(pid)
    }

    /// Snapshot of the setup runner state (used by tests and future status
    /// requests).
    pub fn setup_state(&self) -> Option<SetupState> {
        if self.setup.has_script() {
            Some(self.setup.state())
        } else {
            None
        }
    }
}

/// Validate and normalize an exec timeout. Defaults to 30 s, clamped to
/// 1..=600 per `ori exec --timeout`.
pub fn validate_timeout(requested: Option<u64>) -> Result<Duration, String> {
    let secs = requested.unwrap_or(EXEC_TIMEOUT_DEFAULT_SECS);
    if !(EXEC_TIMEOUT_MIN_SECS..=EXEC_TIMEOUT_MAX_SECS).contains(&secs) {
        return Err(format!(
            "timeout must be between {EXEC_TIMEOUT_MIN_SECS} and {EXEC_TIMEOUT_MAX_SECS} seconds"
        ));
    }
    Ok(Duration::from_secs(secs))
}

fn encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_validation() {
        assert_eq!(validate_timeout(None), Ok(Duration::from_secs(30)));
        assert_eq!(validate_timeout(Some(1)), Ok(Duration::from_secs(1)));
        assert_eq!(validate_timeout(Some(600)), Ok(Duration::from_secs(600)));
        assert!(validate_timeout(Some(0)).is_err());
        assert!(validate_timeout(Some(601)).is_err());
    }

    #[test]
    fn command_env_overlays_claim_env() {
        let mut cfg = serde_json::from_str::<Config>(
            r#"{"controlPlaneUrl":"ws://x","token":"t","sandboxId":"ori_x"}"#,
        )
        .unwrap();
        cfg.claim.env.insert("CLAIMED".into(), "yes".into());
        let agent = Agent::new(cfg);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(agent.apply_claim(&agent.cfg.claim.clone()));
        let env = agent.command_env();
        assert_eq!(env.get("CLAIMED").map(String::as_str), Some("yes"));
        // Inherited env (PATH etc.) is preserved.
        assert!(env.contains_key("PATH"));
    }
}