//! Generic capability conformance suite.
//!
//! Run against every real provider that declares a capability: a provider
//! claiming `fs_snapshot: true` must pass the snapshot round-trip, one claiming
//! `live_suspend: true` must survive a stop/start with guest state intact, and
//! so on. This is what keeps the abstraction honest as backends are added —
//! a capability nobody verifies is a capability somebody will ship that is a lie.
//!
//! This is a shared module, not a test binary. Backend-specific tests
//! (`tests/docker_conformance.rs`, `tests/proxmox_conformance.rs`) include it
//! and run it against their real backend (a Docker socket; a Proxmox host
//! behind `ORI_PVE_*` env).
//!
//! Two capabilities are deliberately **not** asserted here because the trait
//! exposes no probe for them and no provider's base image guarantees the guest
//! side: `desktop` (guest-side VNC/WebRTC) and `nested_containers`
//! (docker-in-sandbox needs a guest docker runtime that the template may not
//! ship). They remain declarations the server may trust or refuse; everything
//! else is proven.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use ori_providers::reconcile::{
    ExecRequest, InstanceHandle, InstanceSpec, InstanceStatus, MachineType, Provider, StopMode,
};

const EXEC_TIMEOUT: Duration = Duration::from_secs(30);

/// A provider under conformance plus the backend's spec factory.
///
/// `make_spec` builds a fresh `InstanceSpec` per instance; the backend owns its
/// id space (Docker ignores `vmid`, Proxmox hands out free vmids), so the
/// factory — not this suite — decides what an instance looks like.
pub struct Conformance {
    pub provider: Arc<dyn Provider>,
    make_spec: Arc<dyn Fn(&str) -> InstanceSpec + Send + Sync>,
    seq: AtomicU32,
}

impl Conformance {
    pub fn new<F>(provider: Arc<dyn Provider>, make_spec: F) -> Self
    where
        F: Fn(&str) -> InstanceSpec + Send + Sync + 'static,
    {
        Self {
            provider,
            make_spec: Arc::new(make_spec),
            seq: AtomicU32::new(1),
        }
    }

    fn spec(&self, tag: &str) -> InstanceSpec {
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        (self.make_spec)(&format!("ori-conf-{tag}-{n}"))
    }

    async fn exec(&self, h: &InstanceHandle, command: Vec<String>) -> Result<String, String> {
        let res = self
            .provider
            .exec(
                h,
                ExecRequest {
                    command,
                    timeout: Some(EXEC_TIMEOUT),
                    env: vec![],
                    workdir: None,
                },
            )
            .await
            .map_err(|e| format!("exec: {e}"))?;
        let stdout = String::from_utf8_lossy(&res.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&res.stderr).into_owned();
        if res.exit_code != 0 {
            return Err(format!(
                "exec exit {}\nstdout: {stdout}\nstderr: {stderr}",
                res.exit_code
            ));
        }
        Ok(stdout)
    }

    /// Run every conformance test the provider's declared capabilities imply,
    /// plus the base trait contract. Returns the list of failures (empty on
    /// success).
    pub async fn run(&self) -> Vec<String> {
        let caps = self.provider.capabilities();
        let mut failures = Vec::new();

        if let Err(e) = self.idempotent_lifecycle().await {
            failures.push(format!("base lifecycle: {e}"));
        }
        if caps.fs_snapshot {
            if let Err(e) = self.snapshot_roundtrip().await {
                failures.push(format!("fs_snapshot: {e}"));
            }
        }
        if caps.linked_clone {
            if let Err(e) = self.linked_clone_roundtrip().await {
                failures.push(format!("linked_clone: {e}"));
            }
        }
        if caps.live_suspend {
            if let Err(e) = self.suspend_resume_persists_state().await {
                failures.push(format!("live_suspend: {e}"));
            }
        }
        if caps.resize_online {
            if let Err(e) = self.resize_keeps_instance_running().await {
                failures.push(format!("resize_online: {e}"));
            }
        }
        failures
    }

    /// Base trait contract, independent of any capability: create starts the
    /// instance; stop/start are idempotent; exec reaches the guest; destroy is
    /// idempotent.
    async fn idempotent_lifecycle(&self) -> Result<(), String> {
        let spec = self.spec("lifecycle");
        let h = self
            .provider
            .create(&spec)
            .await
            .map_err(|e| format!("create: {e}"))?;
        let result: Result<(), String> = async {
            self.provider
                .stop(&h, StopMode::Force)
                .await
                .map_err(|e| format!("stop#1: {e}"))?;
            self.provider
                .stop(&h, StopMode::Force)
                .await
                .map_err(|e| format!("stop#2 must be idempotent: {e}"))?;
            self.provider
                .start(&h)
                .await
                .map_err(|e| format!("start#1: {e}"))?;
            self.provider
                .start(&h)
                .await
                .map_err(|e| format!("start#2 must be idempotent: {e}"))?;
            let st = self
                .provider
                .status(&h)
                .await
                .map_err(|e| format!("status: {e}"))?;
            if st != InstanceStatus::Running {
                return Err(format!("expected Running after start, got {st:?}"));
            }
            let out = self.exec(&h, vec!["sh".into(), "-c".into(), "echo conformance-ok".into()]).await?;
            if !out.contains("conformance-ok") {
                return Err(format!("exec stdout missing marker: {out:?}"));
            }
            self.provider
                .destroy(&h)
                .await
                .map_err(|e| format!("destroy#1: {e}"))?;
            self.provider
                .destroy(&h)
                .await
                .map_err(|e| format!("destroy#2 must be idempotent: {e}"))?;
            Ok(())
        }
        .await;
        let _ = self.provider.destroy(&h).await;
        result
    }

    /// `fs_snapshot: true` ⇒ a running instance snapshots, and snapshot delete
    /// is idempotent.
    async fn snapshot_roundtrip(&self) -> Result<(), String> {
        let spec = self.spec("snapshot");
        let h = self
            .provider
            .create(&spec)
            .await
            .map_err(|e| format!("create: {e}"))?;
        let result: Result<(), String> = async {
            let snap = self
                .provider
                .snapshot(&h, "conf-snap")
                .await
                .map_err(|e| format!("snapshot: {e}"))?;
            if snap.provider != self.provider.name() {
                return Err(format!(
                    "snapshot provider {} != instance provider {}",
                    snap.provider,
                    self.provider.name()
                ));
            }
            if snap.id.is_empty() {
                return Err("snapshot ref id is empty".to_string());
            }
            self.provider
                .snapshot_delete(&snap)
                .await
                .map_err(|e| format!("snapshot_delete#1: {e}"))?;
            self.provider
                .snapshot_delete(&snap)
                .await
                .map_err(|e| format!("snapshot_delete#2 must be idempotent: {e}"))?;
            Ok(())
        }
        .await;
        let _ = self.provider.destroy(&h).await;
        result
    }

    /// `linked_clone: true` ⇒ a snapshot yields a stopped clone that starts
    /// into a working instance.
    async fn linked_clone_roundtrip(&self) -> Result<(), String> {
        let src_spec = self.spec("clone-src");
        let child_spec = self.spec("clone-child");
        let mut created: Vec<InstanceHandle> = Vec::new();
        let result: Result<(), String> = async {
            let src = self
                .provider
                .create(&src_spec)
                .await
                .map_err(|e| format!("create src: {e}"))?;
            created.push(src.clone());
            let snap = self
                .provider
                .snapshot(&src, "conf-golden")
                .await
                .map_err(|e| format!("snapshot: {e}"))?;
            let child = Provider::clone_from(self.provider.as_ref(), &snap, &child_spec)
                .await
                .map_err(|e| format!("clone_from: {e}"))?;
            created.push(child.clone());
            // The clone is left stopped by contract; starting it must work.
            self.provider
                .start(&child)
                .await
                .map_err(|e| format!("start clone: {e}"))?;
            let st = self
                .provider
                .status(&child)
                .await
                .map_err(|e| format!("status clone: {e}"))?;
            if st != InstanceStatus::Running {
                return Err(format!("clone expected Running, got {st:?}"));
            }
            Ok(())
        }
        .await;
        for h in &created {
            let _ = self.provider.destroy(h).await;
        }
        result
    }

    /// `live_suspend: true` ⇒ guest state written before a stop(Snapshot)
    /// survives the subsequent start.
    async fn suspend_resume_persists_state(&self) -> Result<(), String> {
        let spec = self.spec("suspend");
        let marker = "ori-conf-suspend-marker";
        let h = self
            .provider
            .create(&spec)
            .await
            .map_err(|e| format!("create: {e}"))?;
        let result: Result<(), String> = async {
            let out = self.exec(
                &h,
                vec![
                    "sh".into(),
                    "-c".into(),
                    format!("echo {marker} > /tmp/ori-conf-marker"),
                ],
            )
            .await?;
            if !out.contains(marker) {
                return Err(format!("marker write failed: {out:?}"));
            }
            self.provider
                .stop(&h, StopMode::Snapshot)
                .await
                .map_err(|e| format!("suspend (stop Snapshot): {e}"))?;
            self.provider
                .start(&h)
                .await
                .map_err(|e| format!("resume (start): {e}"))?;
            let out = self
                .exec(&h, vec!["sh".into(), "-c".into(), "cat /tmp/ori-conf-marker".into()])
                .await?;
            if !out.contains(marker) {
                return Err(format!(
                    "marker lost across suspend/resume; read back: {out:?}"
                ));
            }
            Ok(())
        }
        .await;
        let _ = self.provider.destroy(&h).await;
        result
    }

    /// `resize_online: true` ⇒ a running instance survives resize and is still
    /// running afterwards.
    async fn resize_keeps_instance_running(&self) -> Result<(), String> {
        let spec = self.spec("resize");
        let h = self
            .provider
            .create(&spec)
            .await
            .map_err(|e| format!("create: {e}"))?;
        let result: Result<(), String> = async {
            self.provider
                .resize(&h, MachineType::Default)
                .await
                .map_err(|e| format!("resize: {e}"))?;
            let st = self
                .provider
                .status(&h)
                .await
                .map_err(|e| format!("status: {e}"))?;
            if st != InstanceStatus::Running {
                return Err(format!(
                    "a resize_online provider must stay running after resize, got {st:?}"
                ));
            }
            Ok(())
        }
        .await;
        let _ = self.provider.destroy(&h).await;
        result
    }
}