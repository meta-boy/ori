//! Foreground `exec`: spawn a command, stream its output, enforce a timeout,
//! and propagate its exit code.
//!
//! The round trip is the reason the agent exists — `ori exec` through
//! `pct exec` over SSH measures 2.7 s against a 1 s target (SSH alone is
//! 0.90 s). The outbound tunnel removes the SSH hop; the command itself still
//! dominates, so nothing here may add overhead to a short command: no shell
//! wrap, no buffering beyond the OS pipe, direct `spawn` + read.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncReadExt, BufReader};
use tokio::sync::mpsc;

use crate::wire::EXIT_CODE_TIMED_OUT;

/// Outcome of a foreground exec.
#[derive(Debug, Clone)]
pub struct ExecOutcome {
    /// Agent-side process id.
    pub pid: i32,
    /// The remote exit code. Killed-by-timeout is reported as 124
    /// (`EXIT_CODE_TIMED_OUT`); signal deaths are 128 + signal.
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub duration: Duration,
    pub timed_out: bool,
}

impl Default for ExecOutcome {
    fn default() -> Self {
        Self {
            pid: 0,
            exit_code: 0,
            stdout: Vec::new(),
            stderr: Vec::new(),
            duration: Duration::ZERO,
            timed_out: false,
        }
    }
}

/// Run a command to completion (or timeout).
///
/// stdout and stderr are streamed through `chunk_stdout` / `chunk_stderr` as
/// they arrive **and** accumulated into the returned outcome, so the caller can
/// both render live and produce a final aggregate. On timeout the process group
/// is killed with SIGKILL and the outcome reports `timed_out` with exit code
/// 124.
///
/// `argv` must be non-empty; the first element is the program.
pub async fn run(
    argv: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    timeout: Duration,
    chunk_stdout: mpsc::Sender<Vec<u8>>,
    chunk_stderr: mpsc::Sender<Vec<u8>>,
) -> ExecOutcome {
    if argv.is_empty() {
        return ExecOutcome {
            exit_code: 2,
            stderr: b"empty command".to_vec(),
            ..Default::default()
        };
    }

    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);

    let start = tokio::time::Instant::now();
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ExecOutcome {
                exit_code: 2,
                stderr: format!("cannot spawn {}: {e}", argv[0]).into_bytes(),
                ..Default::default()
            };
        }
    };
    let pid = child.id().map(|p| p as i32).unwrap_or(0);

    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let (stdout_buf, stderr_buf) = (Vec::new(), Vec::new());
    let (stdout_buf, stderr_buf) = (
        std::sync::Arc::new(std::sync::Mutex::new(stdout_buf)),
        std::sync::Arc::new(std::sync::Mutex::new(stderr_buf)),
    );

    let mut readers = Vec::new();
    if let Some(mut o) = out.take() {
        let tx = chunk_stdout.clone();
        let buf = stdout_buf.clone();
        readers.push(tokio::spawn(async move {
            let mut r = BufReader::new(&mut o);
            let mut chunk = vec![0u8; 8192];
            loop {
                match r.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.lock().unwrap().extend_from_slice(&chunk[..n]);
                        let _ = tx.send(chunk[..n].to_vec()).await;
                    }
                }
            }
        }));
    }
    if let Some(mut e) = err.take() {
        let tx = chunk_stderr.clone();
        let buf = stderr_buf.clone();
        readers.push(tokio::spawn(async move {
            let mut r = BufReader::new(&mut e);
            let mut chunk = vec![0u8; 8192];
            loop {
                match r.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.lock().unwrap().extend_from_slice(&chunk[..n]);
                        let _ = tx.send(chunk[..n].to_vec()).await;
                    }
                }
            }
        }));
    }

    // Drop our copies so the readers are the sole owners of the senders.
    drop(out);
    drop(err);

    let (timed_out, exit_status) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => (false, status.ok()),
        Err(_elapsed) => {
            kill_group(pid);
            // Reap. `wait` resolves once SIGKILL lands.
            let _ = child.wait().await;
            (true, None)
        }
    };

    for r in readers {
        let _ = r.await;
    }

    let stdout = std::mem::take(&mut *stdout_buf.lock().unwrap());
    let stderr = std::mem::take(&mut *stderr_buf.lock().unwrap());

    let exit_code = match (timed_out, exit_status) {
        (true, _) => EXIT_CODE_TIMED_OUT,
        (false, Some(status)) => exit_code_of(status),
        (false, None) => 1,
    };

    ExecOutcome {
        pid,
        exit_code,
        stdout,
        stderr,
        duration: start.elapsed(),
        timed_out,
    }
}

/// Kill a spawned process group. With `process_group(0)` the child leads a new
/// group whose id equals its pid, so `kill(-pid)` reaches the command and its
/// descendants. The direct pid is also signalled as a fallback for the rare
/// case where group creation failed.
#[cfg(unix)]
pub(crate) fn kill_group(pid: i32) {
    if pid > 0 {
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

/// Normalize a child exit status to an exit code: the code when the process
/// exited, `128 + signal` when it was killed by a signal.
pub fn exit_code_of(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(c) = status.code() {
            return c;
        }
        if let Some(sig) = status.signal() {
            return 128 + sig;
        }
        1
    }
    #[cfg(not(unix))]
    {
        status.code().unwrap_or(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exits_with_the_remote_code() {
        let (sout, _rout) = mpsc::channel(4);
        let (serr, _rerr) = mpsc::channel(4);
        let argv = vec!["sh".into(), "-c".into(), "exit 42".into()];
        let outcome = run(&argv, Path::new("/"), &HashMap::new(), Duration::from_secs(30), sout, serr).await;
        assert!(!outcome.timed_out);
        assert_eq!(outcome.exit_code, 42);
    }

    #[tokio::test]
    async fn streams_stdout_and_stderr() {
        let (sout, mut rout) = mpsc::channel::<Vec<u8>>(4);
        let (serr, mut rerr) = mpsc::channel::<Vec<u8>>(4);
        let h_out = tokio::spawn(async move {
            let mut all = Vec::new();
            while let Some(c) = rout.recv().await {
                all.extend_from_slice(&c);
            }
            all
        });
        let h_err = tokio::spawn(async move {
            let mut all = Vec::new();
            while let Some(c) = rerr.recv().await {
                all.extend_from_slice(&c);
            }
            all
        });
        let argv = vec![
            "sh".into(),
            "-c".into(),
            "printf out; printf err >&2".into(),
        ];
        let outcome =
            run(&argv, Path::new("/"), &HashMap::new(), Duration::from_secs(30), sout, serr).await;
        assert_eq!(outcome.exit_code, 0);
        assert_eq!(String::from_utf8(outcome.stdout).unwrap(), "out");
        assert_eq!(String::from_utf8(outcome.stderr).unwrap(), "err");
        assert_eq!(String::from_utf8(h_out.await.unwrap()).unwrap(), "out");
        assert_eq!(String::from_utf8(h_err.await.unwrap()).unwrap(), "err");
    }

    #[tokio::test]
    async fn enforces_timeout_and_kills_process_group() {
        let (sout, _rout) = mpsc::channel(4);
        let (serr, _rerr) = mpsc::channel(4);
        let argv = vec!["sh".into(), "-c".into(), "sleep 30".into()];
        let start = tokio::time::Instant::now();
        let outcome =
            run(&argv, Path::new("/"), &HashMap::new(), Duration::from_millis(300), sout, serr).await;
        assert!(outcome.timed_out);
        assert_eq!(outcome.exit_code, EXIT_CODE_TIMED_OUT);
        assert!(start.elapsed() < Duration::from_secs(5), "must not wait out the full sleep");
    }

    #[tokio::test]
    async fn propagates_environment() {
        let (sout, _rout) = mpsc::channel(4);
        let (serr, _rerr) = mpsc::channel(4);
        let mut env = HashMap::new();
        env.insert("ORI_TEST_VAR".into(), "hello".into());
        let argv = vec!["sh".into(), "-c".into(), "printf %s \"$ORI_TEST_VAR\"".into()];
        let outcome = run(&argv, Path::new("/"), &env, Duration::from_secs(30), sout, serr).await;
        assert_eq!(String::from_utf8(outcome.stdout).unwrap(), "hello");
    }

    #[test]
    fn signal_death_maps_to_128_plus_signal() {
        // `sh -c 'kill -TERM $$'` dies by SIGTERM (15) → exit code 143.
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (sout, _rout) = mpsc::channel(4);
        let (serr, _rerr) = mpsc::channel(4);
        let argv = vec!["sh".into(), "-c".into(), "kill -TERM $$".into()];
        let outcome = rt.block_on(run(
            &argv,
            Path::new("/"),
            &HashMap::new(),
            Duration::from_secs(30),
            sout,
            serr,
        ));
        assert_eq!(outcome.exit_code, 128 + 15);
    }
}