use std::time::Duration;

use crate::reconcile::{ExecRequest, ExecResult};

use super::error::PveError;

/// The provider's `exec` is the **bootstrap-only fallback**. The primary exec
/// path is the guest agent over the control-plane tunnel (server-side, C6);
/// this module exists so bootstrap commands can run before the agent is up.
///
/// It shells out to the system `ssh` binary (the control plane must have one)
/// and runs `pct exec <vmid> -- <cmd>` on the PVE host. The PVE host parses the
/// remote command with its shell, so every argv element is single-quoted;
/// stdout/stderr and the exit code propagate through OpenSSH intact.
pub struct PctExec {
    /// `user@host` plus any flags, e.g. `root@10.0.0.5 -p 2222`.
    ssh_target: String,
    identity_file: Option<std::path::PathBuf>,
    /// Whether to auto-accept new host keys (`-o StrictHostKeyChecking=accept-new`).
    accept_new_host_keys: bool,
}

impl PctExec {
    pub fn new(ssh_target: impl Into<String>, identity_file: Option<std::path::PathBuf>) -> Self {
        Self {
            ssh_target: ssh_target.into(),
            identity_file,
            accept_new_host_keys: true,
        }
    }

    pub fn with_accept_new_host_keys(mut self, on: bool) -> Self {
        self.accept_new_host_keys = on;
        self
    }

    fn shell_quote(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('\'');
        for c in s.chars() {
            if c == '\'' {
                out.push_str("'\\''");
            } else {
                out.push(c);
            }
        }
        out.push('\'');
        out
    }

    /// Build the remote command line executed by the PVE host's shell:
    /// `cd <wd> && env K=V ... && pct exec <vmid> -- <argv…>`.
    fn remote_command(vmid: u32, req: &ExecRequest) -> String {
        let mut parts: Vec<String> = Vec::new();
        if let Some(wd) = &req.workdir {
            parts.push("cd".to_string());
            parts.push(Self::shell_quote(wd));
            parts.push("&&".to_string());
        }
        if !req.env.is_empty() {
            parts.push("env".to_string());
            for (k, v) in &req.env {
                parts.push(format!("{}={}", Self::shell_quote(k), Self::shell_quote(v)));
            }
        }
        parts.extend(req.command.iter().map(|a| Self::shell_quote(a)));
        format!("pct exec {vmid} -- {}", parts.join(" "))
    }

    /// Run `pct exec` over SSH. Returns the container command's stdout,
    /// stderr, and exit code. A transport-level SSH failure is an error; a
    /// non-zero exit code from the command itself is a normal result.
    pub async fn exec(&self, vmid: u32, req: &ExecRequest) -> Result<ExecResult, PveError> {
        if req.command.is_empty() {
            return Err(PveError::Exec("empty command".to_string()));
        }
        let timeout = req.timeout.unwrap_or(Duration::from_secs(30));

        let mut argv: Vec<String> = vec!["-o".into(), "BatchMode=yes".into()];
        if self.accept_new_host_keys {
            argv.push("-o".into());
            argv.push("StrictHostKeyChecking=accept-new".into());
        }
        argv.push("-o".into());
        argv.push("ConnectTimeout=15".into());
        if let Some(id) = &self.identity_file {
            argv.push("-i".into());
            argv.push(id.display().to_string());
        }
        argv.extend(self.ssh_target.split_whitespace().map(String::from));
        argv.push(Self::remote_command(vmid, req));

        let mut cmd = tokio::process::Command::new("ssh");
        cmd.args(&argv)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let start = tokio::time::Instant::now();
        let child = cmd
            .spawn()
            .map_err(|e| PveError::Exec(format!("cannot spawn ssh: {e}")))?;

        let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(out) => out.map_err(|e| PveError::Exec(format!("ssh failed: {e}")))?,
            Err(_elapsed) => {
                return Err(PveError::Exec(format!("timed out after {timeout:?}")));
            }
        };
        let duration = start.elapsed();

        let exit_code = output.status.code().unwrap_or(255);
        if exit_code == 255 && output.stdout.is_empty() && output.stderr.is_empty() {
            return Err(PveError::Exec(
                "ssh exited 255 with no output (host unreachable or key rejected)".to_string(),
            ));
        }

        Ok(ExecResult {
            exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
            duration,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_shell_metacharacters() {
        assert_eq!(PctExec::shell_quote("plain"), "'plain'");
        assert_eq!(PctExec::shell_quote("a b"), "'a b'");
        assert_eq!(PctExec::shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn builds_remote_command() {
        let req = ExecRequest {
            command: vec!["echo".into(), "hi there".into()],
            timeout: None,
            env: vec![("A".into(), "x y".into())],
            workdir: Some("/tmp".into()),
        };
        let remote = PctExec::remote_command(9911, &req);
        assert_eq!(
            remote,
            "pct exec 9911 -- cd '/tmp' && env 'A'='x y' 'echo' 'hi there'"
        );
    }
}
