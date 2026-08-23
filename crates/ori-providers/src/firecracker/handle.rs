//! Firecracker instance handles are sanitized jailer ids; the jail layout
//! under `<chroot_base>/firecracker/<id>/root/` is defined here too so every
//! submodule agrees on where things live. Both are opaque to the server, so
//! the provider defines the encoding.
//!
//! Jail layout (all inside the jail so the jailed Firecracker can reach them):
//!
//! ```text
//! <chroot_base>/firecracker/<id>/root/
//!   firecracker          the binary the jailer copied in
//!   firecracker.pid      the running Firecracker's pid (written by the jailer)
//!   kernel               copied vmlinux
//!   rootfs               copied rootfs image
//!   run/firecracker.socket  the control API socket
//!   vsock.sock           host side of the vsock device (bootstrap exec)
//!   console.out          serial console output
//!   snapshot/vmstate     microVM state file (written on suspend)
//!   snapshot/mem         guest memory file — MUST OUTLIVE the resumed VM
//! ```

use std::path::{Path, PathBuf};

use crate::reconcile::{InstanceHandle, InstanceSpec};

use super::config::FirecrackerConfig;
use super::error::FcError;

/// Max length of a jailer `--id` (alphanumerics and hyphens, 64 chars).
const JAILER_ID_MAX: usize = 64;

/// Sanitize a caller-allocated instance id into a jailer-valid `--id`.
///
/// The jailer accepts `[a-zA-Z0-9-]` up to 64 chars. Instance ids are not
/// guaranteed to match (UUIDs with colons, `mock:1`, spaces), so this is a
/// deterministic 1:1-ish mapping — the handle id is the sanitized id and
/// round-trips through the server.
pub fn jailer_id_for(id: &str) -> String {
    let mut out = String::with_capacity(id.len().min(JAILER_ID_MAX));
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || c == '-' {
            out.push(c);
        } else {
            out.push('-');
        }
        if out.len() == JAILER_ID_MAX {
            break;
        }
    }
    // A leading hyphen would make `--id <id>` parse as a flag; force an
    // alphanumeric start.
    if out.is_empty() {
        out.push('v');
    }
    if !out.as_bytes()[0].is_ascii_alphanumeric() {
        out.insert(0, 'v');
    }
    if out.len() > JAILER_ID_MAX {
        out.truncate(JAILER_ID_MAX);
    }
    out
}

pub fn handle_for(id: &str) -> InstanceHandle {
    InstanceHandle {
        provider: "firecracker".to_string(),
        id: jailer_id_for(id),
    }
}

/// Parse an `InstanceHandle` created by this provider into the jailer id.
pub fn parse_handle(h: &InstanceHandle) -> Result<String, FcError> {
    if h.provider != "firecracker" {
        return Err(FcError::WrongProvider(h.provider.clone()));
    }
    if h.id.is_empty() {
        return Err(FcError::MalformedHandle(h.id.clone()));
    }
    Ok(h.id.clone())
}

/// The chroot jail root for an instance id: `<base>/firecracker/<id>/root`.
pub fn jail_root_for(config: &FirecrackerConfig, id: &str) -> PathBuf {
    config
        .chroot_base_dir
        .join("firecracker")
        .join(id)
        .join("root")
}

/// The control API socket, jail-relative `run/firecracker.socket`.
pub fn api_socket_for(jail_root: &Path) -> PathBuf {
    jail_root.join("run").join("firecracker.socket")
}

/// The pidfile the jailer writes, `<jail_root>/firecracker.pid`.
pub fn pid_file_for(jail_root: &Path) -> PathBuf {
    jail_root.join("firecracker.pid")
}

/// The host side of the vsock device, `<jail_root>/vsock.sock`.
pub fn vsock_socket_for(jail_root: &Path) -> PathBuf {
    jail_root.join("vsock.sock")
}

/// The kernel image materialized into the jail.
pub fn kernel_in_jail(jail_root: &Path) -> PathBuf {
    jail_root.join("kernel")
}

/// The rootfs image materialized into the jail.
pub fn rootfs_in_jail(jail_root: &Path) -> PathBuf {
    jail_root.join("rootfs")
}

/// The directory holding suspend snapshots, `<jail_root>/snapshot`.
pub fn snapshot_dir_for(jail_root: &Path) -> PathBuf {
    jail_root.join("snapshot")
}

/// The microVM state file written on suspend.
pub fn vmstate_for(jail_root: &Path) -> PathBuf {
    snapshot_dir_for(jail_root).join("vmstate")
}

/// The guest memory file written on suspend.
///
/// **Lifetime rule:** this file backs the resumed VM's memory (`MAP_PRIVATE`,
/// pages faulted in on demand) for the whole lifetime of that VM. Deleting it
/// under a resumed microVM is the failure mode that is hardest to debug — the
/// guest corrupts or crashes on a page fault. Only `destroy` removes it (with
/// the whole jail).
pub fn mem_for(jail_root: &Path) -> PathBuf {
    snapshot_dir_for(jail_root).join("mem")
}

/// A suspended instance is one that has a suspend snapshot on disk.
pub fn has_suspend_state(jail_root: &Path) -> bool {
    vmstate_for(jail_root).exists()
}

/// The machine size an instance was created with, persisted so `start` can
/// cold-boot a stopped instance without an `InstanceSpec` (the trait gives
/// `start` only the handle).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct InstanceMeta {
    pub vcpu: u32,
    pub mem_mib: u64,
}

pub fn meta_path(jail_root: &Path) -> PathBuf {
    jail_root.join("meta.json")
}

pub fn write_meta(jail_root: &Path, meta: InstanceMeta) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&meta)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(meta_path(jail_root), bytes)
}

pub fn read_meta(jail_root: &Path) -> Result<Option<InstanceMeta>, FcError> {
    let path = meta_path(jail_root);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(FcError::Io)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| FcError::Data(format!("{} not JSON: {e}", path.display())))
}

/// The rootfs image for a spec: `spec.template` overrides the configured
/// rootfs (the server fills `template` from its per-environment config).
pub fn rootfs_for(config: &FirecrackerConfig, spec: &InstanceSpec) -> PathBuf {
    if spec.template.is_empty() {
        config.rootfs_path.clone()
    } else {
        PathBuf::from(&spec.template)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jailer_id_sanitizes() {
        assert_eq!(jailer_id_for("sandbox_1"), "sandbox-1");
        assert_eq!(jailer_id_for("mock:1"), "mock-1");
        assert_eq!(jailer_id_for("a/b c"), "a-b-c");
    }

    #[test]
    fn jailer_id_prefixes_non_alphanumeric_leading_char() {
        assert_eq!(jailer_id_for("-leading"), "v-leading");
        assert_eq!(jailer_id_for(""), "v");
    }

    #[test]
    fn jailer_id_is_stable_under_64_chars() {
        let id = "x".repeat(200);
        let out = jailer_id_for(&id);
        assert_eq!(out.len(), JAILER_ID_MAX);
        assert!(out.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    #[test]
    fn handle_round_trips() {
        let h = handle_for("sandbox_1");
        assert_eq!(parse_handle(&h).unwrap(), "sandbox-1");
        assert!(matches!(
            parse_handle(&InstanceHandle {
                provider: "proxmox".to_string(),
                id: "sandbox-1".to_string(),
            }),
            Err(FcError::WrongProvider(_))
        ));
        assert!(matches!(
            parse_handle(&InstanceHandle {
                provider: "firecracker".to_string(),
                id: String::new(),
            }),
            Err(FcError::MalformedHandle(_))
        ));
    }

    #[test]
    fn jail_layout_is_inside_the_jail() {
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
        let root = jail_root_for(&config, "abc-1");
        assert_eq!(root, PathBuf::from("/srv/jailer/firecracker/abc-1/root"));
        // Every host-reachable artifact lives under the jail root.
        for p in [
            api_socket_for(&root),
            pid_file_for(&root),
            vsock_socket_for(&root),
            kernel_in_jail(&root),
            rootfs_in_jail(&root),
            vmstate_for(&root),
            mem_for(&root),
        ] {
            assert!(p.starts_with(&root), "{p:?} escaped the jail");
        }
    }

    #[test]
    fn template_overrides_rootfs() {
        let config = FirecrackerConfig {
            jailer_path: "/usr/bin/jailer".into(),
            firecracker_path: "/usr/bin/firecracker".into(),
            kernel_path: "/opt/vmlinux".into(),
            rootfs_path: "/opt/default.ext4".into(),
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
        let spec = InstanceSpec {
            id: "x".into(),
            vmid: 1,
            name: "x".into(),
            machine_type: crate::reconcile::MachineType::Small,
            template: "/opt/override.ext4".into(),
            storage: String::new(),
            environment: None,
            environment_version: None,
        };
        assert_eq!(
            rootfs_for(&config, &spec),
            PathBuf::from("/opt/override.ext4")
        );
        let empty_tpl = InstanceSpec {
            template: String::new(),
            ..spec
        };
        assert_eq!(
            rootfs_for(&config, &empty_tpl),
            PathBuf::from("/opt/default.ext4")
        );
    }

    #[test]
    fn instance_meta_round_trips() {
        let dir = std::env::temp_dir().join(format!("fc-meta-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_meta(&dir).unwrap(), None);
        write_meta(
            &dir,
            InstanceMeta {
                vcpu: 8,
                mem_mib: 16384,
            },
        )
        .unwrap();
        assert_eq!(
            read_meta(&dir).unwrap(),
            Some(InstanceMeta {
                vcpu: 8,
                mem_mib: 16384
            })
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
