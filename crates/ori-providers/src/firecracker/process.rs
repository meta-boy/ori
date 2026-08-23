//! Jailer process management: spawn one jailed Firecracker per microVM,
//! wait for its control socket, and terminate it via the pidfile the jailer
//! writes.
//!
//! The jailer is run with `--daemonize`, so the process we spawn double-forks
//! and exits; the grandchild becomes the Firecracker daemon and writes its own
//! pid to `<jail_root>/firecracker.pid` just before exec'ing. We signal that
//! pid to stop an instance, which keeps process management working across
//! server restarts (no live `Child` handle to lose).

use std::path::Path;
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::sleep;

use super::config::FirecrackerConfig;
use super::error::FcError;
use super::handle::{api_socket_for, pid_file_for};

const SOCKET_POLL_INTERVAL: Duration = Duration::from_millis(100);
const DEATH_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Spawn the jailer for `id` and wait until its control socket exists.
///
/// On entry any stale socket/pidfile from a previous run is cleared — the
/// jailer's pidfile write is `create_new`, so a leftover pidfile would abort
/// the spawn.
pub async fn spawn_jailer(
    config: &FirecrackerConfig,
    id: &str,
    jail_root: &Path,
) -> Result<(), FcError> {
    std::fs::create_dir_all(jail_root).map_err(FcError::Io)?;
    let socket = api_socket_for(jail_root);
    let pidfile = pid_file_for(jail_root);
    // Remove stale artifacts; a fresh run owns the jail now.
    let _ = std::fs::remove_file(&pidfile);
    let _ = std::fs::remove_file(&socket);

    let mut child = Command::new(&config.jailer_path)
        .arg("--id")
        .arg(id)
        .arg("--exec-file")
        .arg(&config.firecracker_path)
        .arg("--uid")
        .arg(config.uid.to_string())
        .arg("--gid")
        .arg(config.gid.to_string())
        .arg("--daemonize")
        .arg("--chroot-base-dir")
        .arg(&config.chroot_base_dir)
        // Everything after `--` is forwarded to the jailed Firecracker.
        .arg("--")
        .arg("--api-sock")
        .arg("run/firecracker.socket")
        .kill_on_drop(true)
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(FcError::Io)?;

    let deadline = Instant::now() + config.boot_timeout();
    loop {
        if socket.exists() {
            let _ = child.wait().await; // reap the forking parent
            return Ok(());
        }
        if let Some(status) = child.try_wait().map_err(FcError::Io)? {
            let stderr = drain_stderr(&mut child).await;
            return Err(FcError::JailerFailed {
                id: id.to_string(),
                status: status.to_string(),
                stderr,
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill().await;
            let stderr = drain_stderr(&mut child).await;
            let msg = if stderr.trim().is_empty() {
                format!(
                    "{id} did not reach control socket within {:?}",
                    config.boot_timeout()
                )
            } else {
                format!(
                    "{id} did not reach control socket within {:?}; jailer stderr: {}",
                    config.boot_timeout(),
                    stderr.trim()
                )
            };
            return Err(FcError::Other(msg));
        }
        sleep(SOCKET_POLL_INTERVAL).await;
    }
}

/// Read the pidfile, terminate the Firecracker process (SIGTERM, then SIGKILL
/// after the grace period), and clear stale socket/pidfile. Idempotent: a
/// missing jail, pidfile, or already-dead process is fine.
pub async fn terminate(
    config: &FirecrackerConfig,
    _id: &str,
    jail_root: &Path,
) -> Result<(), FcError> {
    let pidfile = pid_file_for(jail_root);
    let pid = read_pid(&pidfile)?;
    if let Some(pid) = pid {
        let _ = signal(pid, libc::SIGTERM);
        let deadline = Instant::now() + config.terminate_grace();
        loop {
            if !process_alive(pid) {
                break;
            }
            if Instant::now() >= deadline {
                let _ = signal(pid, libc::SIGKILL);
            }
            sleep(DEATH_POLL_INTERVAL).await;
        }
    }
    let _ = std::fs::remove_file(&pidfile);
    let _ = std::fs::remove_file(api_socket_for(jail_root));
    Ok(())
}

/// The pid of the running Firecracker for this jail, if the jailer wrote one.
pub fn read_pid(pidfile: &Path) -> Result<Option<i32>, FcError> {
    if !pidfile.exists() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(pidfile).map_err(FcError::Io)?;
    match contents.trim().parse::<i32>() {
        Ok(pid) if pid > 0 => Ok(Some(pid)),
        _ => Ok(None),
    }
}

/// Whether a pid is alive, portable to non-Linux build hosts. `kill(pid, 0)`
/// succeeds for a live pid and for one owned by another user (EPERM); only
/// ESRCH means the process is gone.
pub fn process_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: kill with sig 0 only probes; no signal is delivered.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Send a signal to a pid.
fn signal(pid: i32, sig: i32) -> std::io::Result<()> {
    // SAFETY: kill is async-signal-safe; passing a valid signal number.
    let rc = unsafe { libc::kill(pid, sig) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Drain a child's piped stderr after it has exited (or was killed).
async fn drain_stderr(child: &mut tokio::process::Child) -> String {
    let Some(mut err) = child.stderr.take() else {
        return String::new();
    };
    let mut out = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(1), err.read_to_string(&mut out)).await;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_alive_rejects_invalid_and_absent_pids() {
        assert!(!process_alive(0));
        assert!(!process_alive(-1));
        // 2^31-1 is essentially never a live pid on a real host.
        assert!(!process_alive(i32::MAX));
    }

    #[test]
    fn read_pid_parses_file() {
        let dir = std::env::temp_dir().join(format!("fc-pid-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pf = dir.join("firecracker.pid");
        std::fs::write(&pf, "4242\n").unwrap();
        assert_eq!(read_pid(&pf).unwrap(), Some(4242));
        std::fs::write(&pf, "garbage").unwrap();
        assert_eq!(read_pid(&pf).unwrap(), None);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(read_pid(&dir.join("missing.pid")).unwrap(), None);
    }

    #[test]
    fn terminate_without_pidfile_is_ok() {
        let config = FirecrackerConfig {
            jailer_path: "/usr/bin/jailer".into(),
            firecracker_path: "/usr/bin/firecracker".into(),
            kernel_path: "/opt/vmlinux".into(),
            rootfs_path: "/opt/rootfs.ext4".into(),
            boot_args: String::new(),
            chroot_base_dir: "/srv/jailer".into(),
            uid: 123,
            gid: 100,
            tap: None,
            exec_port: 8086,
            guest_cid: 3,
            exec_timeout_secs: 60,
            boot_timeout_secs: 30,
            terminate_grace_secs: 5,
        };
        let dir = std::env::temp_dir().join(format!("fc-term-{}", std::process::id()));
        let jail = dir.join("root");
        std::fs::create_dir_all(&jail).unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(terminate(&config, "x", &jail)).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
