//! Detached process lifecycle: spawn in the background, log to
//! `~/.ori/processes/<pid>.log`, and answer `--status <pid>` polls.
//!
//! A detached process is put in its own process group so a signal to the agent
//! (or its group) does not take the job down with it, and stdout/stderr are
//! appended to a per-pid log file. The agent keeps a registry of pids it has
//! spawned; a pid it no longer knows about reports `lost` — the agent may have
//! restarted under it, or the pid was never ours. That is reported as data
//! (`state: "lost"`), never as an error.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::error::AgentError;
use crate::exec::exit_code_of;

/// Tail of a detached-process log returned by `--status`, capped so a chatty
/// job cannot balloon a status poll.
pub const LOG_TAIL_MAX_BYTES: u64 = 4096;

/// State of a detached process as far as the agent knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcState {
    Running,
    Exited(i32),
}

/// A process the agent spawned detached.
#[derive(Debug, Clone)]
pub struct DetachedProc {
    pub pid: i32,
    pub state: ProcState,
    pub log_path: PathBuf,
}

/// Answer to a `--status <pid>` poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcStatus {
    Running,
    Exited(i32),
    /// The agent no longer has this pid. Not an error: the agent may have
    /// restarted under it, or the pid belongs to another process entirely.
    Lost,
}

/// Registry of detached processes the agent has spawned.
#[derive(Debug, Default)]
pub struct Registry {
    procs: HashMap<i32, DetachedProc>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, proc: DetachedProc) {
        self.procs.insert(proc.pid, proc);
    }

    /// Answer a status poll for `pid`.
    pub fn status(&self, pid: i32) -> ProcStatus {
        match self.procs.get(&pid) {
            Some(p) => match p.state {
                ProcState::Running => ProcStatus::Running,
                ProcState::Exited(code) => ProcStatus::Exited(code),
            },
            None => ProcStatus::Lost,
        }
    }

    /// Record that a detached child exited. Called from the monitor task.
    pub fn record_exit(&mut self, pid: i32, code: i32) {
        if let Some(p) = self.procs.get_mut(&pid) {
            p.state = ProcState::Exited(code);
        }
    }

    /// Tail of the process log, if the file still exists.
    pub fn log_tail(&self, pid: i32, max_bytes: u64) -> Option<String> {
        let p = self.procs.get(&pid)?;
        tail_file(&p.log_path, max_bytes)
    }
}

/// Spawn a process detached and return its pid, the child handle (so the caller
/// can `wait()` it), and the log path.
///
/// The log file is created (0600) at a placeholder name first, because the pid
/// is not known until the process is spawned; it is then atomically renamed to
/// `<pid>.log`. Both stdout and stderr append to it.
pub async fn spawn_child(
    argv: &[String],
    env: &HashMap<String, String>,
    cwd: &Path,
    logs_dir: &Path,
) -> Result<(i32, tokio::process::Child, PathBuf), AgentError> {
    if argv.is_empty() {
        return Err(AgentError::Other("empty command".into()));
    }
    std::fs::create_dir_all(logs_dir)?;

    let placeholder = logs_dir.join(format!(".spawn-{}-{}.log", std::process::id(), counter()));

    let stdout_file = open_append_0600(&placeholder)?;
    let stderr_file = open_append_0600(&placeholder)?;

    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(stdout_file))
        .stderr(std::process::Stdio::from(stderr_file))
        .kill_on_drop(false);
    #[cfg(unix)]
    cmd.process_group(0);

    let child = cmd
        .spawn()
        .map_err(|e| AgentError::Other(format!("cannot spawn detached {}: {e}", argv[0])))?;
    let pid = child.id().map(|p| p as i32).unwrap_or(0);

    let final_path = log_path_for(logs_dir, pid);
    std::fs::rename(&placeholder, &final_path)
        .map_err(|e| AgentError::Other(format!("cannot rename process log: {e}")))?;

    Ok((pid, child, final_path))
}

/// Fully-qualified log path for a pid: `~/.ori/processes/<pid>.log`.
pub fn log_path_for(logs_dir: &Path, pid: i32) -> PathBuf {
    logs_dir.join(format!("{pid}.log"))
}

/// Tail the last `max_bytes` of a file, decoded lossy.
pub fn tail_file(path: &Path, max_bytes: u64) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(max_bytes);
    if start > 0 {
        f.seek(SeekFrom::Start(start)).ok()?;
    }
    let mut buf = Vec::with_capacity((len - start).min(max_bytes) as usize);
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Normalize a wait result into a status code.
pub fn status_code(status: std::io::Result<std::process::ExitStatus>) -> i32 {
    match status {
        Ok(s) => exit_code_of(s),
        Err(_) => 1,
    }
}

/// Monotonic counter for placeholder log names, to avoid collisions when
/// several detaches happen in the same microsecond.
fn counter() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static C: AtomicU64 = AtomicU64::new(0);
    C.fetch_add(1, Ordering::Relaxed)
}

/// Open (creating 0600) a file in append mode. Secret logs are as private as
/// secrets: a detached job may be writing tokens.
#[cfg(unix)]
fn open_append_0600(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?;
    // Belt and braces: a pre-existing file with a looser mode must be tightened.
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    Ok(f)
}

#[cfg(not(unix))]
fn open_append_0600(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_file_reads_last_bytes() {
        let dir = std::env::temp_dir().join(format!("ori-agent-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("proc.log");
        std::fs::write(&path, b"0123456789").unwrap();
        assert_eq!(tail_file(&path, 4).as_deref(), Some("6789"));
        assert_eq!(tail_file(&path, 100).as_deref(), Some("0123456789"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn status_of_unknown_pid_is_lost() {
        let reg = Registry::new();
        assert_eq!(reg.status(123456), ProcStatus::Lost);
    }

    #[test]
    fn status_tracks_running_then_exited() {
        let mut reg = Registry::new();
        reg.insert(DetachedProc {
            pid: 7,
            state: ProcState::Running,
            log_path: PathBuf::from("/tmp/x.log"),
        });
        assert_eq!(reg.status(7), ProcStatus::Running);
        reg.record_exit(7, 3);
        assert_eq!(reg.status(7), ProcStatus::Exited(3));
    }
}
