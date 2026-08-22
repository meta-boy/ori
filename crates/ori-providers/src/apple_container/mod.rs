//! Apple container backend — **honest stub**, not an implementation.
//!
//! Every method returns [`Error::ProviderNotImplemented`]. A stub that returned
//! `Ok(())` and did nothing would be worse than absent: it would be mistaken
//! for working. Capabilities below are what the real backend will be able to
//! do, so the server can plan around them today.
//!
//! What the real implementation needs:
//! - A macOS host running the `Virtualization` framework; an "apple container"
//!   is a lightweight macOS VM, not a Linux namespace container.
//! - The real `create` boots a restore image (`.ipsw`); `clone_from` copies the
//!   disk image; `exec` goes through the guest agent (C6) over the control-plane
//!   tunnel once it is up — there is no unprivileged `docker exec` analogue.
//! - `desktop: true` because macOS instances have a real GUI reachable through
//!   Screen Sharing (VNC), matching the provider `desktop` contract.
//!
//! Declared capabilities: `desktop: true` only. No O(1) clone, no filesystem
//! snapshot while running, no memory suspend/resume, no online resize, no
//! nested containers.

/// Build a `ProviderNotImplemented` error for this provider.
macro_rules! not_impl {
    ($op:literal) => {
        Err(crate::reconcile::Error::ProviderNotImplemented {
            provider: "apple-container",
            operation: $op,
        })
    };
}

use async_trait::async_trait;

use crate::reconcile::{
    Addresses, Capabilities, Error, ExecRequest, ExecResult, InstanceHandle, InstanceSpec,
    InstanceStatus, MachineType, Provider, SnapshotRef, StopMode,
};

/// The Apple container backend. Currently a stub: construction succeeds, but
/// every operation returns [`Error::ProviderNotImplemented`].
#[derive(Debug, Clone, Copy, Default)]
pub struct AppleContainerProvider;

impl AppleContainerProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Provider for AppleContainerProvider {
    fn name(&self) -> &'static str {
        "apple-container"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            linked_clone: false,
            fs_snapshot: false,
            live_suspend: false,
            resize_online: false,
            desktop: true,
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
    async fn declares_desktop_but_implements_nothing() {
        let p = AppleContainerProvider::new();
        assert_eq!(p.name(), "apple-container");
        let caps = p.capabilities();
        assert!(
            caps.desktop,
            "macOS instances have a GUI (Screen Sharing/VNC)"
        );
        assert!(!caps.linked_clone && !caps.fs_snapshot && !caps.live_suspend);

        let h = InstanceHandle {
            provider: "apple-container".to_string(),
            id: "x".to_string(),
        };
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
        let err = p
            .create(&spec)
            .await
            .expect_err("stub must not fake success");
        assert!(
            matches!(
                err,
                Error::ProviderNotImplemented {
                    provider: "apple-container",
                    operation: "create"
                }
            ),
            "got: {err}"
        );
        let err = p.start(&h).await.expect_err("stub must not fake success");
        assert!(matches!(err, Error::ProviderNotImplemented { .. }));
        let err = p
            .snapshot(&h, "golden")
            .await
            .expect_err("stub must not fake success");
        assert!(matches!(err, Error::ProviderNotImplemented { .. }));
    }
}
