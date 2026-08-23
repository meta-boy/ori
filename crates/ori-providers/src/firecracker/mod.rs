//! Firecracker microVM backend (`Provider` impl) over the per-microVM control
//! API, with each microVM spawned under the **jailer**.
//!
//! This backend exists for exactly one capability LXC cannot offer:
//! **`live_suspend`** — memory-state suspend/resume. Firecracker persists the
//! full VM (CPU registers, memory, emulated device state) with
//! `PUT /snapshot/create`, and a fresh Firecracker process restores it with
//! `PUT /snapshot/load`. Restore maps the memory file `MAP_PRIVATE`, so pages
//! fault in **on demand** and resume is fast (Fly.io runs this design in
//! production with resume in a few hundred milliseconds; our LXC resume
//! measures 4.3 s). `stop` and `start` are therefore snapshot-create /
//! snapshot-load, **not** a power cycle — a power cycle would offer nothing
//! LXC does not already do.
//!
//! ## The jailer and the memory-file lifetime rule
//!
//! Every microVM is one daemonized Firecracker process under the jailer, in a
//! per-instance chroot at `<chroot_base>/firecracker/<id>/root/`. Under the
//! jail the control socket, the vsock UDS, the kernel, the rootfs and the
//! snapshot files **all live inside the jail** (relative paths in the API),
//! and the jailer writes the Firecracker pid to `firecracker.pid` so we can
//! signal it. The one rule that will be hardest to debug if violated:
//!
//! > **The memory file (`snapshot/mem`) must outlive the resumed VM.** After
//! > `snapshot-load` it backs the guest's memory read-only through the page
//! > cache; deleting it under a resumed VM corrupts guest memory. Only
//! > `destroy` removes it (with the whole jail). `start`/`resume` never touch
//! > it.
//!
//! ## Operation mapping
//!
//! | `Provider` | Firecracker control API |
//! |---|---|
//! | `create` | jail the VM, materialize kernel+rootfs, `PUT /machine-config`, `/boot-source`, `/drives/rootfs`, `/vsock`, then `PUT /actions InstanceStart` |
//! | `stop` (Snapshot) | `PATCH /vm Paused` → `PUT /snapshot/create` (Full) → terminate the process |
//! | `stop` (Force) | terminate the process (no snapshot; data-losing) |
//! | `start` (resume) | fresh jailer → `PUT /snapshot/load` (`File` backend, `resume_vm`) |
//! | `start` (cold) | fresh jailer → re-configure + `InstanceStart` |
//! | `status` | `GET /` (`Running`/`Paused`/`Not started`) |
//! | `exec` | vsock bootstrap channel (guest shim, see [`exec`]) |
//! | `destroy` | terminate + remove the jail (and the memory file) |
//!
//! ## Honest capabilities
//!
//! Only `live_suspend: true`. There is no O(1) clone (`linked_clone: false`),
//! no filesystem snapshot while running (`fs_snapshot: false` — the snapshot
//! API captures the whole VM and is used internally by suspend/resume),
//! machine-config is pre-boot only so no online resize, and a bare microVM has
//! no desktop or nested-container surface.
//!
//! ## `exec` — bootstrap-only fallback
//!
//! The primary exec path is the guest agent over the control-plane tunnel
//! (C6); this provider method is the documented bootstrap fallback and rides a
//! vsock channel to a small guest shim (reference: [`exec::EXEC_SHIM_RS`]).
//! Without the shim listening, `exec` fails loudly — it never fakes success.

pub mod client;
pub mod config;
pub mod error;
pub mod exec;
pub mod handle;
pub mod process;

use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;

pub use config::FirecrackerConfig;
pub use error::FcError;
pub use handle::{handle_for, jailer_id_for, parse_handle};

use client::ApiClient;
use handle::InstanceMeta;

use crate::reconcile::{
    Addresses, Capabilities, Error, ExecRequest, ExecResult, InstanceHandle, InstanceSpec,
    InstanceStatus, MachineType, Provider, SnapshotRef, StopMode,
};

/// Build a `ProviderNotImplemented` error for this provider.
macro_rules! not_impl {
    ($op:literal) => {
        Err(crate::reconcile::Error::ProviderNotImplemented {
            provider: "firecracker",
            operation: $op,
        })
    };
}

/// The Firecracker backend. One jail per instance, one daemonized Firecracker
/// process per instance, snapshot-create/load suspend and resume.
#[derive(Clone, Debug)]
pub struct FirecrackerProvider {
    config: FirecrackerConfig,
}

impl FirecrackerProvider {
    pub fn new(config: FirecrackerConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &FirecrackerConfig {
        &self.config
    }

    fn jail_root(&self, id: &str) -> std::path::PathBuf {
        handle::jail_root_for(&self.config, id)
    }

    /// Is a Firecracker process currently alive for this jail?
    fn is_live(&self, jail_root: &Path) -> bool {
        match process::read_pid(&handle::pid_file_for(jail_root)) {
            Ok(Some(pid)) => process::process_alive(pid),
            _ => false,
        }
    }

    /// Spawn the jailer for a fresh process, then cold-boot the guest.
    async fn boot_cold(
        &self,
        id: &str,
        jail_root: &Path,
        spec: &InstanceSpec,
    ) -> Result<(), Error> {
        process::spawn_jailer(&self.config, id, jail_root)
            .await
            .map_err(map_err)?;
        let client = ApiClient::new(handle::api_socket_for(jail_root));
        let (vcpu, mem_mib) = machine_config(spec);
        client
            .set_machine_config(vcpu, mem_mib)
            .await
            .map_err(map_err)?;
        client
            .set_boot_source("kernel", &self.config.boot_args)
            .await
            .map_err(map_err)?;
        client.set_drive("rootfs").await.map_err(map_err)?;
        client
            .set_vsock(self.config.guest_cid, "vsock.sock")
            .await
            .map_err(map_err)?;
        client.set_serial("console.out").await.map_err(map_err)?;
        if let Some(tap) = &self.config.tap {
            client.set_network(tap).await.map_err(map_err)?;
        }
        client.instance_start().await.map_err(map_err)?;
        Ok(())
    }

    /// Cold-boot from the instance's stored meta (no `InstanceSpec` available
    /// on `start`).
    async fn boot_from_meta(&self, id: &str, jail_root: &Path) -> Result<(), Error> {
        let meta = handle::read_meta(jail_root).map_err(map_err)?.ok_or_else(|| {
            Error::InvalidTransition(format!(
                "firecracker instance {id} has no stored machine config (meta.json missing); recreate it"
            ))
        })?;
        process::spawn_jailer(&self.config, id, jail_root)
            .await
            .map_err(map_err)?;
        let client = ApiClient::new(handle::api_socket_for(jail_root));
        client
            .set_machine_config(meta.vcpu, meta.mem_mib)
            .await
            .map_err(map_err)?;
        client
            .set_boot_source("kernel", &self.config.boot_args)
            .await
            .map_err(map_err)?;
        client.set_drive("rootfs").await.map_err(map_err)?;
        client
            .set_vsock(self.config.guest_cid, "vsock.sock")
            .await
            .map_err(map_err)?;
        client.set_serial("console.out").await.map_err(map_err)?;
        if let Some(tap) = &self.config.tap {
            client.set_network(tap).await.map_err(map_err)?;
        }
        client.instance_start().await.map_err(map_err)?;
        Ok(())
    }

    /// Resume a suspended instance: fresh jailer, then `PUT /snapshot/load`.
    /// Must be the first configuration call on the fresh process. The memory
    /// file now backs this VM's pages and must stay (see module docs).
    async fn resume_from_snapshot(&self, id: &str, jail_root: &Path) -> Result<(), Error> {
        process::spawn_jailer(&self.config, id, jail_root)
            .await
            .map_err(map_err)?;
        let client = ApiClient::new(handle::api_socket_for(jail_root));
        client
            .load_snapshot("snapshot/vmstate", "snapshot/mem", true)
            .await
            .map_err(map_err)
    }
}

/// (vcpu, mem_size_mib) for a machine type — the Firecracker machine-config
/// numbers mirror the trait's sizing table.
fn machine_config(spec: &InstanceSpec) -> (u32, u64) {
    (
        spec.machine_type.vcpu(),
        spec.machine_type.memory_gb() as u64 * 1024,
    )
}

/// Map a filesystem error into the shared provider error taxonomy.
fn map_io(e: std::io::Error) -> Error {
    map_err(FcError::Io(e))
}

/// Map a Firecracker low-level error into the shared provider error taxonomy.
fn map_err(e: FcError) -> Error {
    match e {
        FcError::Http { status, message } => match status {
            404 => Error::NotFound(message),
            409 => Error::Conflict(message),
            429 => Error::RateLimited(message),
            400 => Error::InvalidRequest(message),
            _ => Error::ProviderUnavailable(format!("firecracker {status}: {message}")),
        },
        FcError::Transport(m) | FcError::Data(m) | FcError::Other(m) => {
            Error::ProviderUnavailable(m)
        }
        FcError::JailerFailed { id, status, stderr } => {
            Error::ProviderUnavailable(format!("jailer for {id} exited {status}: {stderr}"))
        }
        FcError::MalformedHandle(id) => Error::InvalidRequest(format!("malformed handle {id}")),
        FcError::WrongProvider(p) => {
            Error::InvalidRequest(format!("handle belongs to provider {p}"))
        }
        FcError::Config(m) => Error::InvalidRequest(m),
        FcError::NotRunning(id) => {
            Error::InvalidTransition(format!("instance {id} is not running"))
        }
        FcError::Io(e) => Error::Other(e.to_string()),
    }
}

#[async_trait]
impl Provider for FirecrackerProvider {
    fn name(&self) -> &'static str {
        "firecracker"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            linked_clone: false,
            fs_snapshot: false,
            // Snapshot-create/load persists memory + disk — genuinely
            // suspendable, and the whole reason this backend exists.
            live_suspend: true,
            resize_online: false,
            desktop: false,
            nested_containers: false,
            max_instances: None,
        }
    }

    /// Cold create from the kernel + rootfs, then boot. Not idempotent: a
    /// second create for the same id while one is alive conflicts.
    async fn create(&self, spec: &InstanceSpec) -> Result<InstanceHandle, Error> {
        let id = handle::jailer_id_for(&spec.id);
        let jail_root = self.jail_root(&id);
        if self.is_live(&jail_root) {
            return Err(Error::Conflict(format!(
                "firecracker instance {id} is already running"
            )));
        }
        // A stale jail (crashed create/destroy) is rebuilt fresh.
        if jail_root.exists() {
            std::fs::remove_dir_all(&jail_root).map_err(map_io)?;
        }
        std::fs::create_dir_all(&jail_root).map_err(map_io)?;
        // Materialize the kernel and rootfs inside the jail — the jailer docs
        // require every resource the API hands to the VM to live in the jail.
        std::fs::copy(&self.config.kernel_path, handle::kernel_in_jail(&jail_root))
            .map_err(map_io)?;
        let rootfs = handle::rootfs_for(&self.config, spec);
        std::fs::copy(&rootfs, handle::rootfs_in_jail(&jail_root)).map_err(map_io)?;
        // Persist the machine size so `start` can cold-boot without a spec.
        handle::write_meta(
            &jail_root,
            InstanceMeta {
                vcpu: spec.machine_type.vcpu(),
                mem_mib: spec.machine_type.memory_gb() as u64 * 1024,
            },
        )
        .map_err(map_io)?;
        self.boot_cold(&id, &jail_root, spec).await?;
        Ok(handle::handle_for(&spec.id))
    }

    /// There is no O(1) clone primitive; Firecracker has no linked-clone story.
    /// Declared `linked_clone: false`, so this is never exercised by the
    /// conformance suite.
    async fn clone_from(
        &self,
        _src: &SnapshotRef,
        _spec: &InstanceSpec,
    ) -> Result<InstanceHandle, Error> {
        not_impl!("clone_from")
    }

    /// Idempotent: a running instance stays running. A suspended instance
    /// (stop Snapshot) resumes via snapshot-load; a stopped one cold-boots.
    async fn start(&self, h: &InstanceHandle) -> Result<(), Error> {
        let id = parse_handle(h).map_err(map_err)?;
        let jail_root = self.jail_root(&id);
        if !jail_root.exists() {
            return Err(Error::NotFound(format!("firecracker instance {id}")));
        }
        let socket = handle::api_socket_for(&jail_root);
        if socket.exists() {
            let client = ApiClient::new(&socket);
            if let Ok(state) = client.describe_instance().await {
                match state.as_str() {
                    "Running" => return Ok(()),
                    // A process paused in place (stop(Snapshot) crashed between
                    // pause and terminate): resume it without a fresh boot.
                    "Paused" => {
                        client.set_vm_state("Resumed").await.map_err(map_err)?;
                        return Ok(());
                    }
                    _ => {}
                }
            }
            // Process died between the socket check and describe; fall through
            // to a fresh process below.
        }
        if handle::has_suspend_state(&jail_root) {
            self.resume_from_snapshot(&id, &jail_root).await?;
        } else {
            self.boot_from_meta(&id, &jail_root).await?;
        }
        Ok(())
    }

    /// `StopMode::Snapshot` is a **live suspend**: pause, snapshot-create the
    /// full VM, then power off the process. `Force` skips the snapshot.
    /// Idempotent on an already-stopped instance.
    async fn stop(&self, h: &InstanceHandle, mode: StopMode) -> Result<(), Error> {
        let id = parse_handle(h).map_err(map_err)?;
        let jail_root = self.jail_root(&id);
        if !jail_root.exists() {
            return Ok(());
        }
        let socket = handle::api_socket_for(&jail_root);
        if !socket.exists() {
            return Ok(());
        }
        match mode {
            StopMode::Snapshot => {
                let client = ApiClient::new(&socket);
                client.set_vm_state("Paused").await.map_err(map_err)?;
                client
                    .create_snapshot("snapshot/vmstate", "snapshot/mem")
                    .await
                    .map_err(map_err)?;
                // Power off. The memory file at snapshot/mem is left in place:
                // the resumed VM maps it and needs it for its whole lifetime.
                process::terminate(&self.config, &id, &jail_root)
                    .await
                    .map_err(map_err)?;
            }
            StopMode::Force => {
                process::terminate(&self.config, &id, &jail_root)
                    .await
                    .map_err(map_err)?;
            }
        }
        Ok(())
    }

    /// Idempotent: destroying a missing instance is `Ok`. Removes the whole
    /// jail, including the memory file — safe because destroy is the explicit
    /// teardown.
    async fn destroy(&self, h: &InstanceHandle) -> Result<(), Error> {
        let id = parse_handle(h).map_err(map_err)?;
        let jail_root = self.jail_root(&id);
        if !jail_root.exists() {
            return Ok(());
        }
        process::terminate(&self.config, &id, &jail_root)
            .await
            .map_err(map_err)?;
        std::fs::remove_dir_all(&jail_root).map_err(map_io)?;
        Ok(())
    }

    async fn status(&self, h: &InstanceHandle) -> Result<InstanceStatus, Error> {
        let id = parse_handle(h).map_err(map_err)?;
        let jail_root = self.jail_root(&id);
        if !jail_root.exists() {
            return Ok(InstanceStatus::Unknown);
        }
        let socket = handle::api_socket_for(&jail_root);
        if !socket.exists() {
            return Ok(InstanceStatus::Stopped);
        }
        let client = ApiClient::new(&socket);
        match client.describe_instance().await {
            Ok(state) => Ok(match state.as_str() {
                "Running" => InstanceStatus::Running,
                // Paused == suspended; Not started == boot not requested.
                _ => InstanceStatus::Stopped,
            }),
            // Process died between the socket check and describe.
            Err(_) => Ok(InstanceStatus::Stopped),
        }
    }

    /// No filesystem snapshot while running is declared (`fs_snapshot:
    /// false`); the snapshot API captures the whole VM and is used internally
    /// by suspend/resume, so it is not exposed here.
    async fn snapshot(&self, _h: &InstanceHandle, _name: &str) -> Result<SnapshotRef, Error> {
        not_impl!("snapshot")
    }

    async fn rollback(&self, _h: &InstanceHandle, _s: &SnapshotRef) -> Result<(), Error> {
        not_impl!("rollback")
    }

    async fn snapshot_delete(&self, _s: &SnapshotRef) -> Result<(), Error> {
        not_impl!("snapshot_delete")
    }

    /// Bootstrap-only fallback over the vsock channel. The primary exec path
    /// is the guest agent over the control-plane tunnel (C6); this is the
    /// documented provider-side fallback and requires the guest shim
    /// ([`exec::EXEC_SHIM_RS`]) to be listening. Fails loudly otherwise.
    async fn exec(&self, h: &InstanceHandle, req: ExecRequest) -> Result<ExecResult, Error> {
        let id = parse_handle(h).map_err(map_err)?;
        let jail_root = self.jail_root(&id);
        let socket = handle::api_socket_for(&jail_root);
        if !socket.exists() {
            return Err(map_err(FcError::NotRunning(id)));
        }
        let client = ApiClient::new(&socket);
        let state = client.describe_instance().await.map_err(map_err)?;
        if state != "Running" {
            return Err(map_err(FcError::NotRunning(id)));
        }
        let timeout = req
            .timeout
            .unwrap_or_else(|| Duration::from_secs(self.config.exec_timeout_secs));
        exec::run_vsock_exec(
            &handle::vsock_socket_for(&jail_root),
            self.config.exec_port,
            req,
            timeout,
        )
        .await
        .map_err(map_err)
    }

    /// machine-config is pre-boot only, so resize cannot apply online or on
    /// the next start without a suspend/restore cycle. Declared
    /// `resize_online: false`.
    async fn resize(&self, _h: &InstanceHandle, _t: MachineType) -> Result<(), Error> {
        not_impl!("resize")
    }

    /// Firecracker exposes no guest addresses through its API; with the guest
    /// agent (C6) absent the provider cannot know the guest IP. Best-effort
    /// empty until the agent reports them.
    async fn addresses(&self, _h: &InstanceHandle) -> Result<Addresses, Error> {
        Ok(Addresses::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> FirecrackerConfig {
        FirecrackerConfig {
            jailer_path: "/usr/bin/jailer".into(),
            firecracker_path: "/usr/bin/firecracker".into(),
            kernel_path: "/opt/vmlinux".into(),
            rootfs_path: "/opt/rootfs.ext4".into(),
            boot_args: "console=ttyS0 reboot=k panic=1".into(),
            chroot_base_dir: "/srv/jailer".into(),
            uid: 123,
            gid: 100,
            tap: None,
            exec_port: 8086,
            guest_cid: 3,
            exec_timeout_secs: 60,
            boot_timeout_secs: 30,
            terminate_grace_secs: 5,
        }
    }

    fn spec(id: &str) -> InstanceSpec {
        InstanceSpec {
            id: id.to_string(),
            vmid: 1,
            name: id.to_string(),
            machine_type: MachineType::Small,
            template: String::new(),
            storage: String::new(),
            environment: None,
            environment_version: None,
        }
    }

    #[tokio::test]
    async fn declares_live_suspend_and_nothing_else() {
        let p = FirecrackerProvider::new(config());
        assert_eq!(p.name(), "firecracker");
        let caps = p.capabilities();
        assert!(caps.live_suspend, "snapshot create/load is real");
        assert!(
            !caps.linked_clone && !caps.fs_snapshot && !caps.desktop && !caps.resize_online,
            "every other capability stays honest"
        );
    }

    #[tokio::test]
    async fn unimplemented_operations_are_explicit_errors() {
        let p = FirecrackerProvider::new(config());
        let h = InstanceHandle {
            provider: "firecracker".to_string(),
            id: "x".to_string(),
        };
        let snap = SnapshotRef {
            provider: "firecracker".to_string(),
            id: "x".to_string(),
            name: "x".to_string(),
        };
        let cases: Vec<(&str, Result<(), Error>)> = vec![
            (
                "clone_from",
                p.clone_from(&snap, &spec("x")).await.map(|_| ()),
            ),
            ("snapshot", p.snapshot(&h, "golden").await.map(|_| ())),
            ("rollback", p.rollback(&h, &snap).await),
            ("snapshot_delete", p.snapshot_delete(&snap).await),
            ("resize", p.resize(&h, MachineType::Large).await),
        ];
        for (op, res) in cases {
            let err = res.expect_err("must not fake success");
            assert!(
                matches!(
                    err,
                    Error::ProviderNotImplemented {
                        provider: "firecracker",
                        operation: o
                    } if o == op
                ),
                "got: {err}"
            );
        }
    }

    #[tokio::test]
    async fn missing_instance_is_unknown_or_stopped_not_running() {
        let p = FirecrackerProvider::new(config());
        let h = InstanceHandle {
            provider: "firecracker".to_string(),
            id: "no-such-id".to_string(),
        };
        assert_eq!(p.status(&h).await.unwrap(), InstanceStatus::Unknown);
        // destroy and stop are idempotent on a missing instance.
        p.destroy(&h).await.unwrap();
        p.stop(&h, StopMode::Force).await.unwrap();
        // exec fails cleanly, it never fakes success.
        let err = p
            .exec(
                &h,
                ExecRequest {
                    command: vec!["true".into()],
                    timeout: None,
                    env: vec![],
                    workdir: None,
                },
            )
            .await
            .expect_err("not running");
        assert!(err.to_string().contains("not running"), "got: {err}");
    }

    #[tokio::test]
    async fn wrong_provider_handle_is_rejected() {
        let p = FirecrackerProvider::new(config());
        let h = InstanceHandle {
            provider: "proxmox".to_string(),
            id: "x".to_string(),
        };
        let err = p.start(&h).await.expect_err("wrong provider");
        assert!(
            err.to_string().contains("belongs to provider"),
            "got: {err}"
        );
    }

    #[test]
    fn machine_config_matches_trait_numbers() {
        let s = spec("x");
        assert_eq!(machine_config(&s), (2, 4096));
        let large = InstanceSpec {
            machine_type: MachineType::Large,
            ..s
        };
        assert_eq!(machine_config(&large), (8, 16384));
    }

    #[test]
    fn addresses_are_empty_best_effort() {
        let p = FirecrackerProvider::new(config());
        let h = InstanceHandle {
            provider: "firecracker".to_string(),
            id: "x".to_string(),
        };
        let rt = tokio::runtime::Runtime::new().unwrap();
        let addrs = rt.block_on(p.addresses(&h)).unwrap();
        assert!(addrs.v4.is_empty() && addrs.v6.is_empty());
    }
}
