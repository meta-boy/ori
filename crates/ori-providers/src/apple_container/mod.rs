//! Apple container backend (`Provider` impl) over the `container` CLI.
//!
//! `apple/container` runs Linux containers as lightweight VMs on Apple silicon
//! (macOS 26 only), consumes and produces OCI images, and is driven through the
//! `container` CLI (`create`, `start`, `stop`, `exec`, `list`, …). This
//! provider shells out to that CLI.
//!
//! Operation mapping:
//!
//! | `Provider` | `container` call |
//! |---|---|
//! | `create` | `container create --name <id> --cpus N --memory <M>G <image> [sleep infinity]`, then `start` |
//! | `start` | `container start <id>` |
//! | `stop` | `container stop --time 2 <id>` |
//! | `destroy` | `container delete --force <id>` |
//! | `status` | `container list --all --format json` |
//! | `exec` | `container exec [--env] [--workdir] <id> <argv…>` |
//! | `addresses` | `container list --all --format json` → network attachments |
//!
//! ## Declared capabilities — honestly, and why
//!
//! This backend declares **no** snapshot or checkpoint capability:
//! `fs_snapshot: false` and `live_suspend: false`. The wording matters: this
//! is **absence of documented support, not support that was tested and found
//! missing**. As of the reference docs, `apple/container` documents no
//! snapshot or checkpoint primitive — nothing to create a `SnapshotRef` from,
//! nothing to resume memory from. In particular, `container stats --no-stream`
//! is a **metrics readout**, not state capture, and is deliberately **not**
//! wired to `snapshot()`.
//!
//! `desktop: false` corrects the stub's original `desktop: true` guess, which
//! assumed a macOS VM with a Screen Sharing GUI. The real `container` runs
//! Linux VMs with no VNC/WebRTC surface, so there is no desktop to expose.
//! `resize_online: false` and `linked_clone: false`: there is no
//! `container update` for running containers (`container machine set` is for
//! container machines, not containers) and no O(1) clone.
//!
//! ## `exec`
//!
//! As everywhere, the primary exec path is the guest agent over the
//! control-plane tunnel (C6); this provider method is the bootstrap-only
//! fallback via `container exec`.

pub mod cli;
pub mod config;
pub mod error;
pub mod handle;

use std::time::Duration;

use async_trait::async_trait;

pub use config::AppleContainerConfig;
pub use error::AppleError;
pub use handle::{container_id_for, handle_for, parse_handle};

use crate::reconcile::{
    Addresses, Capabilities, Error, ExecRequest, ExecResult, InstanceHandle, InstanceSpec,
    InstanceStatus, MachineType, Provider, SnapshotRef, StopMode,
};

/// Build a `ProviderNotImplemented` error for this provider.
macro_rules! not_impl {
    ($op:literal) => {
        Err(crate::reconcile::Error::ProviderNotImplemented {
            provider: "apple-container",
            operation: $op,
        })
    };
}

/// The Apple container backend.
#[derive(Clone, Debug)]
pub struct AppleContainerProvider {
    config: AppleContainerConfig,
}

impl AppleContainerProvider {
    pub fn new(config: AppleContainerConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &AppleContainerConfig {
        &self.config
    }
}

/// Map a `container` CLI error into the shared provider error taxonomy.
fn map_err(e: AppleError) -> Error {
    match e {
        AppleError::Cli { bin, message } => {
            Error::ProviderUnavailable(format!("container cli {bin}: {message}"))
        }
        AppleError::CliFailed { args, exit, stderr } => {
            Error::ProviderUnavailable(format!("container {args} exited {exit}: {}", stderr.trim()))
        }
        AppleError::MalformedHandle(id) => Error::InvalidRequest(format!("malformed handle {id}")),
        AppleError::WrongProvider(p) => {
            Error::InvalidRequest(format!("handle belongs to provider {p}"))
        }
        AppleError::NotFound(m) => Error::NotFound(m),
        AppleError::Config(m) => Error::InvalidRequest(m),
        AppleError::Io(e) => Error::Other(e.to_string()),
        AppleError::Other(m) => Error::ProviderUnavailable(m),
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
            // No snapshot primitive is documented — absence of documented
            // support, not support that was tested and found missing (see the
            // module docs; `stats --no-stream` is metrics, not state).
            fs_snapshot: false,
            live_suspend: false,
            resize_online: false,
            // The `container` CLI exposes no VNC/WebRTC surface; a Linux VM
            // has no macOS GUI.
            desktop: false,
            nested_containers: false,
            max_instances: None,
        }
    }

    /// Cold create from the image, then start. Not idempotent: the same id
    /// twice conflicts (`container create --name` with a duplicate name).
    async fn create(&self, spec: &InstanceSpec) -> Result<InstanceHandle, Error> {
        let id = handle::container_id_for(&spec.id);
        let image = if spec.template.is_empty() {
            self.config.image.clone()
        } else {
            spec.template.clone()
        };
        let mut args = vec!["create".to_string(), "--name".to_string(), id.clone()];
        args.push("--cpus".to_string());
        args.push(spec.machine_type.vcpu().to_string());
        args.push("--memory".to_string());
        args.push(format!("{}G", spec.machine_type.memory_gb()));
        if let Some(net) = &self.config.network {
            args.push("--network".to_string());
            args.push(net.clone());
        }
        args.push(image);
        if self.config.keep_alive {
            // The image's CMD (alpine's /bin/sh) exits immediately; keep the
            // sandbox alive like docker's keep-alive override.
            args.push("sleep".to_string());
            args.push("infinity".to_string());
        }
        cli::run_ok(&self.config, args).await.map_err(map_err)?;
        self.start(&handle_for(&spec.id)).await?;
        Ok(handle_for(&spec.id))
    }

    /// No O(1) clone exists (`linked_clone: false`), so this is never called
    /// by the conformance suite.
    async fn clone_from(
        &self,
        _src: &SnapshotRef,
        _spec: &InstanceSpec,
    ) -> Result<InstanceHandle, Error> {
        not_impl!("clone_from")
    }

    /// Idempotent: starting an already-running container is `Ok`.
    async fn start(&self, h: &InstanceHandle) -> Result<(), Error> {
        let id = parse_handle(h).map_err(map_err)?;
        let st = cli::instance_status(&self.config, &id)
            .await
            .map_err(map_err)?;
        if st == InstanceStatus::Running {
            return Ok(());
        }
        cli::run_ok(&self.config, vec!["start".to_string(), id])
            .await
            .map_err(map_err)
    }

    /// `Force` stops. `Snapshot` cannot be honored: no snapshot primitive is
    /// documented, so a snapshot-then-stop is impossible. We return
    /// `ProviderNotImplemented` rather than silently downgrading to a
    /// data-losing plain stop.
    async fn stop(&self, h: &InstanceHandle, mode: StopMode) -> Result<(), Error> {
        let id = parse_handle(h).map_err(map_err)?;
        match mode {
            StopMode::Snapshot => not_impl!("stop"),
            StopMode::Force => {
                let st = cli::instance_status(&self.config, &id)
                    .await
                    .map_err(map_err)?;
                if st == InstanceStatus::Stopped || st == InstanceStatus::Unknown {
                    return Ok(());
                }
                cli::run_ok(
                    &self.config,
                    vec![
                        "stop".to_string(),
                        "--time".to_string(),
                        "2".to_string(),
                        id,
                    ],
                )
                .await
                .map_err(map_err)
            }
        }
    }

    /// Idempotent: destroying a missing container is `Ok`.
    async fn destroy(&self, h: &InstanceHandle) -> Result<(), Error> {
        let id = parse_handle(h).map_err(map_err)?;
        let st = cli::instance_status(&self.config, &id)
            .await
            .map_err(map_err)?;
        if st == InstanceStatus::Unknown {
            return Ok(());
        }
        match cli::run(
            &self.config,
            vec!["delete".to_string(), "--force".to_string(), id],
        )
        .await
        {
            Ok((0, _, _)) => Ok(()),
            Ok((exit, _, stderr)) => Err(map_err(AppleError::CliFailed {
                args: "delete --force <id>".to_string(),
                exit,
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            })),
            Err(e) => Err(map_err(e)),
        }
    }

    async fn status(&self, h: &InstanceHandle) -> Result<InstanceStatus, Error> {
        let id = parse_handle(h).map_err(map_err)?;
        cli::instance_status(&self.config, &id)
            .await
            .map_err(map_err)
    }

    /// No snapshot primitive is documented — `stats --no-stream` is a metrics
    /// readout, not state capture, and is deliberately not wired here.
    async fn snapshot(&self, _h: &InstanceHandle, _name: &str) -> Result<SnapshotRef, Error> {
        not_impl!("snapshot")
    }

    async fn rollback(&self, _h: &InstanceHandle, _s: &SnapshotRef) -> Result<(), Error> {
        not_impl!("rollback")
    }

    async fn snapshot_delete(&self, _s: &SnapshotRef) -> Result<(), Error> {
        not_impl!("snapshot_delete")
    }

    /// Bootstrap-only fallback: `container exec`. The primary exec path is the
    /// guest agent over the control-plane tunnel (C6).
    async fn exec(&self, h: &InstanceHandle, req: ExecRequest) -> Result<ExecResult, Error> {
        let id = parse_handle(h).map_err(map_err)?;
        let timeout = req
            .timeout
            .unwrap_or_else(|| Duration::from_secs(self.config.exec_timeout_secs));
        cli::exec(&self.config, &id, req, timeout)
            .await
            .map_err(map_err)
    }

    /// There is no `container update` for running containers (`container
    /// machine set` is for container machines). Declared `resize_online:
    /// false` and unimplemented.
    async fn resize(&self, _h: &InstanceHandle, _t: MachineType) -> Result<(), Error> {
        not_impl!("resize")
    }

    async fn addresses(&self, h: &InstanceHandle) -> Result<Addresses, Error> {
        let id = parse_handle(h).map_err(map_err)?;
        cli::instance_addresses(&self.config, &id)
            .await
            .map_err(map_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> AppleContainerConfig {
        AppleContainerConfig {
            bin: "container".to_string(),
            image: "alpine:latest".to_string(),
            keep_alive: true,
            network: None,
            exec_timeout_secs: 60,
            state_timeout_secs: 60,
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
    async fn declares_no_snapshot_capability_honestly() {
        let p = AppleContainerProvider::new(config());
        assert_eq!(p.name(), "apple-container");
        let caps = p.capabilities();
        // The plan's point: fs_snapshot/live_suspend are false because nothing
        // documents support, not because it was tested and found missing.
        assert!(!caps.fs_snapshot && !caps.live_suspend);
        // The stub's `desktop: true` guess is corrected: `container` runs
        // headless Linux VMs, so there is no VNC/WebRTC surface.
        assert!(!caps.desktop);
        assert!(!caps.linked_clone && !caps.resize_online && !caps.nested_containers);
    }

    #[tokio::test]
    async fn unimplemented_operations_are_explicit_errors() {
        let p = AppleContainerProvider::new(config());
        let h = InstanceHandle {
            provider: "apple-container".to_string(),
            id: "x".to_string(),
        };
        let snap = SnapshotRef {
            provider: "apple-container".to_string(),
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
            // stop(Snapshot) cannot be honored without a snapshot primitive.
            ("stop", p.stop(&h, StopMode::Snapshot).await),
        ];
        for (op, res) in cases {
            let err = res.expect_err("must not fake success");
            assert!(
                matches!(
                    err,
                    Error::ProviderNotImplemented {
                        provider: "apple-container",
                        operation: o
                    } if o == op
                ),
                "got: {err}"
            );
        }
    }
}
