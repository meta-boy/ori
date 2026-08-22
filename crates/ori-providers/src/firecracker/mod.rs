//! Firecracker microVM backend — **honest stub**, not an implementation.
//!
//! Every method returns [`Error::ProviderNotImplemented`]. A stub that returned
//! `Ok(())` and did nothing would be worse than absent: it would be mistaken
//! for working. Capabilities below are what the real backend will be able to
//! do, so the server can plan around them today.
//!
//! What the real implementation needs:
//! - The Firecracker **control API** over a per-VM unix socket
//!   (`/run/firecracker/{vmid}.socket`), spawned via the **jailer** so each
//!   microVM runs as its own uid/gid inside a chroot.
//! - A **kernel** (`vmlinux`) and a **rootfs** image (ext4 qcow2 or raw) —
//!   the real `create` materializes both, and `clone_from` copies the rootfs
//!   onto a new volume.
//! - `snapshot`/`restore` through the `SnapshotCreate`/`SnapshotLoad` control
//!   API; Firecracker genuinely persists memory + disk state here, so
//!   **`live_suspend: true` is accurate** (unlike LXC, where CRIU is measured
//!   failing). `exec` has no guest-agent story on a bare microVM — the real
//!   backend boots an init that runs the agent (C6) and exec rides that tunnel.
//!
//! Declared capabilities: `live_suspend: true` only. Firecracker has no O(1)
//! clone primitive, no online resize, no desktop, no nested containers, and no
//! filesystem snapshot while running (the snapshot API captures the whole VM).

/// Build a `ProviderNotImplemented` error for this provider.
macro_rules! not_impl {
    ($op:literal) => {
        Err(crate::reconcile::Error::ProviderNotImplemented {
            provider: "firecracker",
            operation: $op,
        })
    };
}

use async_trait::async_trait;

use crate::reconcile::{
    Addresses, Capabilities, Error, ExecRequest, ExecResult, InstanceHandle, InstanceSpec,
    InstanceStatus, MachineType, Provider, SnapshotRef, StopMode,
};

/// The Firecracker backend. Currently a stub: construction succeeds, but every
/// operation returns [`Error::ProviderNotImplemented`].
#[derive(Debug, Clone, Copy, Default)]
pub struct FirecrackerProvider;

impl FirecrackerProvider {
    pub fn new() -> Self {
        Self
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
            // Snapshot/restore persists memory + disk — genuinely suspendable.
            live_suspend: true,
            resize_online: false,
            desktop: false,
            nested_containers: false,
            max_instances: None,
        }
    }

    async fn create(&self, _spec: &InstanceSpec) -> Result<InstanceHandle, Error> {
        not_impl!("create")
    }

    async fn clone_from(
        &self,
        _src: &SnapshotRef,
        _spec: &InstanceSpec,
    ) -> Result<InstanceHandle, Error> {
        not_impl!("clone_from")
    }

    async fn start(&self, _h: &InstanceHandle) -> Result<(), Error> {
        not_impl!("start")
    }

    async fn stop(&self, _h: &InstanceHandle, _mode: StopMode) -> Result<(), Error> {
        not_impl!("stop")
    }

    async fn destroy(&self, _h: &InstanceHandle) -> Result<(), Error> {
        not_impl!("destroy")
    }

    async fn status(&self, _h: &InstanceHandle) -> Result<InstanceStatus, Error> {
        not_impl!("status")
    }

    async fn snapshot(&self, _h: &InstanceHandle, _name: &str) -> Result<SnapshotRef, Error> {
        not_impl!("snapshot")
    }

    async fn rollback(&self, _h: &InstanceHandle, _s: &SnapshotRef) -> Result<(), Error> {
        not_impl!("rollback")
    }

    async fn snapshot_delete(&self, _s: &SnapshotRef) -> Result<(), Error> {
        not_impl!("snapshot_delete")
    }

    async fn exec(&self, _h: &InstanceHandle, _req: ExecRequest) -> Result<ExecResult, Error> {
        not_impl!("exec")
    }

    async fn resize(&self, _h: &InstanceHandle, _t: MachineType) -> Result<(), Error> {
        not_impl!("resize")
    }

    async fn addresses(&self, _h: &InstanceHandle) -> Result<Addresses, Error> {
        not_impl!("addresses")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn declares_live_suspend_but_implements_nothing() {
        let p = FirecrackerProvider::new();
        assert_eq!(p.name(), "firecracker");
        let caps = p.capabilities();
        assert!(caps.live_suspend, "firecracker snapshot/restore is real");
        assert!(!caps.linked_clone && !caps.fs_snapshot && !caps.desktop);

        let h = InstanceHandle { provider: "firecracker".to_string(), id: "x".to_string() };
        let spec = InstanceSpec {
            id: "x".to_string(),
            vmid: 1,
            name: "x".to_string(),
            machine_type: MachineType::Small,
            template: String::new(),
            storage: String::new(),
            environment: None,
            environment_version: None,
        };
        let err = p.create(&spec).await.expect_err("stub must not fake success");
        assert!(
            matches!(err, Error::ProviderNotImplemented { provider: "firecracker", operation: "create" }),
            "got: {err}"
        );
        let err = p.start(&h).await.expect_err("stub must not fake success");
        assert!(matches!(err, Error::ProviderNotImplemented { .. }));
        let err = p.exec(&h, ExecRequest { command: vec!["true".into()], timeout: None, env: vec![], workdir: None }).await.expect_err("stub must not fake success");
        assert!(matches!(err, Error::ProviderNotImplemented { .. }));
    }
}