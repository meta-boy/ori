//! Configuration for the Firecracker backend.
//!
//! `serde`-deserializable so the server can construct it from JSON config,
//! plus [`FirecrackerConfig::from_env`] for the integration/conformance tests
//! (`ORI_FC_*`), mirroring `docker::DockerConfig` and `proxmox::ProxmoxConfig`.

use std::path::PathBuf;

use crate::reconcile::Error;

fn default_jailer_path() -> PathBuf {
    PathBuf::from("/usr/bin/jailer")
}

fn default_firecracker_path() -> PathBuf {
    PathBuf::from("/usr/bin/firecracker")
}

fn default_boot_args() -> String {
    // Standard Firecracker serial console boot args. `root=` is left to the
    // kernel's own config so any vmlinux boots the rootfs drive.
    "console=ttyS0 reboot=k panic=1 pci=off".to_string()
}

fn default_chroot_base_dir() -> PathBuf {
    PathBuf::from("/srv/jailer")
}

fn default_uid() -> u32 {
    123
}

fn default_gid() -> u32 {
    100
}

fn default_exec_port() -> u32 {
    8086
}

fn default_guest_cid() -> u32 {
    3
}

fn default_exec_timeout_secs() -> u64 {
    60
}

fn default_boot_timeout_secs() -> u64 {
    30
}

fn default_terminate_grace_secs() -> u64 {
    5
}

/// Configuration for the Firecracker provider.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct FirecrackerConfig {
    /// Path to the jailer binary. Default `/usr/bin/jailer`.
    #[serde(default = "default_jailer_path")]
    pub jailer_path: PathBuf,
    /// Path to the firecracker binary. Default `/usr/bin/firecracker`.
    #[serde(default = "default_firecracker_path")]
    pub firecracker_path: PathBuf,
    /// Host path to the guest kernel (`vmlinux`). Materialized into each jail.
    pub kernel_path: PathBuf,
    /// Host path to the rootfs image (raw ext4 or qcow2). Materialized into
    /// each jail; `spec.template` overrides this for a per-spec rootfs.
    pub rootfs_path: PathBuf,
    /// Kernel command line. Default `console=ttyS0 reboot=k panic=1 pci=off`.
    #[serde(default = "default_boot_args")]
    pub boot_args: String,
    /// Base dir the jailer builds chroot jails under. Default `/srv/jailer`.
    /// Each microVM lives at `<chroot_base_dir>/firecracker/<id>/root/`.
    #[serde(default = "default_chroot_base_dir")]
    pub chroot_base_dir: PathBuf,
    /// UID the jailer drops to for the Firecracker process.
    #[serde(default = "default_uid")]
    pub uid: u32,
    /// GID the jailer drops to for the Firecracker process.
    #[serde(default = "default_gid")]
    pub gid: u32,
    /// Host TAP device the guest's `eth0` attaches to. `None` boots with no
    /// network — the control plane still reaches the guest over vsock, so
    /// `exec` works regardless. `addresses` is empty either way (guest IPs
    /// require the guest agent, C6).
    #[serde(default)]
    pub tap: Option<String>,
    /// vsock port the guest's bootstrap exec shim listens on. Default 8086.
    #[serde(default = "default_exec_port")]
    pub exec_port: u32,
    /// Guest CID for the vsock device. Default 3.
    #[serde(default = "default_guest_cid")]
    pub guest_cid: u32,
    /// Default `exec` timeout in seconds (default 60).
    #[serde(default = "default_exec_timeout_secs")]
    pub exec_timeout_secs: u64,
    /// How long to wait for the control socket after spawning the jailer
    /// (default 30 s).
    #[serde(default = "default_boot_timeout_secs")]
    pub boot_timeout_secs: u64,
    /// How long to wait for a terminated Firecracker to exit before SIGKILL
    /// (default 5 s).
    #[serde(default = "default_terminate_grace_secs")]
    pub terminate_grace_secs: u64,
}

impl FirecrackerConfig {
    /// Build from `ORI_FC_*` environment variables (integration/conformance
    /// tests). The two path fields are required; the rest fall back to
    /// defaults.
    pub fn from_env() -> Result<Self, Error> {
        fn env(name: &str) -> Result<String, Error> {
            std::env::var(name)
                .map_err(|_| Error::InvalidRequest(format!("missing environment variable {name}")))
        }
        Ok(FirecrackerConfig {
            jailer_path: std::env::var("ORI_FC_JAILER")
                .map(PathBuf::from)
                .unwrap_or_else(|_| default_jailer_path()),
            firecracker_path: std::env::var("ORI_FC_FIRECRACKER")
                .map(PathBuf::from)
                .unwrap_or_else(|_| default_firecracker_path()),
            kernel_path: PathBuf::from(env("ORI_FC_KERNEL")?),
            rootfs_path: PathBuf::from(env("ORI_FC_ROOTFS")?),
            boot_args: std::env::var("ORI_FC_BOOT_ARGS").unwrap_or_else(|_| default_boot_args()),
            chroot_base_dir: std::env::var("ORI_FC_CHROOT_BASE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| default_chroot_base_dir()),
            uid: std::env::var("ORI_FC_UID")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_uid),
            gid: std::env::var("ORI_FC_GID")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_gid),
            tap: std::env::var("ORI_FC_TAP").ok(),
            exec_port: std::env::var("ORI_FC_EXEC_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_exec_port),
            guest_cid: std::env::var("ORI_FC_GUEST_CID")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_guest_cid),
            exec_timeout_secs: std::env::var("ORI_FC_EXEC_TIMEOUT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_exec_timeout_secs),
            boot_timeout_secs: std::env::var("ORI_FC_BOOT_TIMEOUT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_boot_timeout_secs),
            terminate_grace_secs: std::env::var("ORI_FC_TERMINATE_GRACE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_terminate_grace_secs),
        })
    }

    pub fn boot_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.boot_timeout_secs.max(1))
    }

    pub fn terminate_grace(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.terminate_grace_secs.max(1))
    }
}
