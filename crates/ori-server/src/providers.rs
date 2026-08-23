//! Provider construction and the bridge between the server's `Provider`
//! trait (`crate::proto`) and the real backends in `ori-providers`.
//!
//! `ProxmoxAdapter` is wiring only: it converts the server's domain types
//! onto `ori_providers::reconcile` at the boundary and allocates VMIDs from
//! SQLite. It does not implement Proxmox behaviour — `ProxmoxProvider` does.
//! The one genuine decision here is VMID allocation: the architecture owns the
//! 100..=999_999_999 id space from SQLite (`vmid_allocations`) and the provider
//! cross-checks each id against `/cluster/nextid`.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use sqlx::SqlitePool;

use crate::config::{Config, ProviderKind};
use crate::mock::MockProvider;
use crate::proto::{self, Provider};
use ori_providers::reconcile::Provider as _;

/// Scratch range reserved for integration tests; the pool must never allocate
/// here (`.env.local` reserves 9000-9099).
const TEST_VMID_MIN: i64 = 9000;
const TEST_VMID_MAX: i64 = 9099;

/// Build the provider selected by `config.provider`. The Proxmox path runs its
/// startup preflight here (node online, storage snapshot-capable, template
/// present, token can create) so a misconfiguration fails loudly at boot
/// instead of on the first `fork`.
pub async fn build_provider(
    config: &Config,
    db: SqlitePool,
) -> Result<Arc<dyn Provider>, Box<dyn std::error::Error>> {
    match config.provider {
        ProviderKind::Mock => Ok(Arc::new(MockProvider::new())),
        ProviderKind::Proxmox => {
            let pconf = ori_providers::proxmox::ProxmoxConfig::from_env().map_err(|e| {
                format!("proxmox provider selected but ORI_PVE_* config is incomplete: {e}")
            })?;
            let inner = ori_providers::proxmox::ProxmoxProvider::new(pconf.clone())
                .await
                .map_err(|e| format!("proxmox preflight failed: {e}"))?;
            let vmid_min = std::env::var("ORI_PVE_VMID_MIN")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1000);
            Ok(Arc::new(ProxmoxAdapter::new(inner, db, vmid_min)))
        }
        ProviderKind::Docker => {
            Err("docker provider is not implemented in this build; pick `mock` or `proxmox`".into())
        }
    }
}

/// Server-side bridge over `ori_providers::proxmox::ProxmoxProvider`.
pub struct ProxmoxAdapter {
    inner: ori_providers::proxmox::ProxmoxProvider,
    db: SqlitePool,
    /// Lowest vmid the pool may allocate (default 1000, above typical PVE
    /// auto-allocation which starts at 100).
    vmid_min: i64,
}

impl ProxmoxAdapter {
    pub fn new(
        inner: ori_providers::proxmox::ProxmoxProvider,
        db: SqlitePool,
        vmid_min: i64,
    ) -> Self {
        ProxmoxAdapter {
            inner,
            db,
            vmid_min: vmid_min.max(100),
        }
    }

    /// Monotonic VMID from `vmid_allocations`, cross-checked against the live
    /// node: the counter is the starting point, the node's existing VMID list
    /// is the arbiter for what is actually free. A colliding id is burned in
    /// the DB so it is never retried.
    async fn allocate_vmid(&self) -> Result<u32, proto::ProviderError> {
        let existing: std::collections::HashSet<u32> = self
            .inner
            .client()
            .lxc_vmids()
            .await
            .map_err(|e| proto::ProviderError::Failed(format!("cannot list node vmids: {e}")))?
            .into_iter()
            .collect();
        let nextid = self
            .inner
            .client()
            .nextid()
            .await
            .unwrap_or(self.vmid_min as u32);
        for _ in 0..200 {
            let row: (Option<i64>,) =
                sqlx::query_as("SELECT MAX(vmid) FROM vmid_allocations WHERE provider = 'proxmox'")
                    .fetch_one(&self.db)
                    .await
                    .map_err(|e| proto::ProviderError::Failed(format!("vmid allocation: {e}")))?;
            let mut next = (row.0.unwrap_or(self.vmid_min - 1) + 1)
                .max(self.vmid_min)
                .max(nextid as i64);
            if (TEST_VMID_MIN..=TEST_VMID_MAX).contains(&next) {
                next = TEST_VMID_MAX + 1;
            }
            let vmid = u32::try_from(next)
                .map_err(|_| proto::ProviderError::Failed("vmid counter overflow".into()))?;
            if existing.contains(&vmid) {
                let _ = sqlx::query(
                    "INSERT OR IGNORE INTO vmid_allocations (vmid, provider, account_id, sandbox_id, created_at) \
                     VALUES (?, 'proxmox', 'default', NULL, ?)",
                )
                .bind(vmid)
                .bind(crate::util::now_ts())
                .execute(&self.db)
                .await;
                continue;
            }
            let res = sqlx::query(
                "INSERT INTO vmid_allocations (vmid, provider, account_id, sandbox_id, created_at) \
                 VALUES (?, 'proxmox', 'default', NULL, ?)",
            )
            .bind(vmid)
            .bind(crate::util::now_ts())
            .execute(&self.db)
            .await;
            match res {
                Ok(_) => return Ok(vmid),
                Err(e) if crate::repo::is_unique_violation(&e) => continue,
                Err(e) => {
                    return Err(proto::ProviderError::Failed(format!(
                        "vmid allocation: {e}"
                    )));
                }
            }
        }
        Err(proto::ProviderError::Failed(
            "could not allocate a free vmid".into(),
        ))
    }

    fn to_spec(
        &self,
        spec: &proto::InstanceSpec,
        vmid: u32,
    ) -> ori_providers::reconcile::InstanceSpec {
        let pconf = self.inner.config();
        ori_providers::reconcile::InstanceSpec {
            id: spec.id.clone(),
            vmid,
            name: spec.name.clone(),
            machine_type: machine_to(spec.machine_type),
            template: pconf.template.clone(),
            storage: pconf.storage.clone(),
            environment: Some(spec.environment.clone()),
            environment_version: Some(spec.environment_version as u32),
        }
    }

    fn to_handle(h: &proto::InstanceHandle) -> ori_providers::reconcile::InstanceHandle {
        ori_providers::reconcile::InstanceHandle {
            provider: h.provider.clone(),
            id: h.id.clone(),
        }
    }

    /// The server's `SnapshotRef` only carries `name`; Proxmox snapshot refs
    /// are `node/vmid/name`. The full id is packed into `name` here and split
    /// back in `from_snapshot_ref`. Snapshot refs live only for the duration
    /// of a single fork/stop request, so nothing durable depends on this.
    fn to_snapshot_ref(s: &proto::SnapshotRef) -> ori_providers::reconcile::SnapshotRef {
        let id = s.name.clone();
        ori_providers::reconcile::SnapshotRef {
            provider: s.provider.clone(),
            id,
            name: s.name.clone(),
        }
    }

    fn from_snapshot_ref(s: ori_providers::reconcile::SnapshotRef) -> proto::SnapshotRef {
        proto::SnapshotRef {
            provider: s.provider,
            name: s.id,
        }
    }

    fn to_exec_req(req: &proto::ExecRequest) -> ori_providers::reconcile::ExecRequest {
        ori_providers::reconcile::ExecRequest {
            command: req.cmd.clone(),
            timeout: req.timeout_secs.map(Duration::from_secs),
            env: req
                .env
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            workdir: req.cwd.clone(),
        }
    }

    fn from_exec_result(r: ori_providers::reconcile::ExecResult) -> proto::ExecResult {
        proto::ExecResult {
            pid: 0,
            completed: true,
            exit_code: r.exit_code as i64,
            stdout: String::from_utf8_lossy(&r.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&r.stderr).into_owned(),
            duration_ms: r.duration.as_millis() as i64,
        }
    }

    fn from_addresses(a: ori_providers::reconcile::Addresses) -> proto::Addresses {
        let ip =
            a.v4.first()
                .or_else(|| a.v6.first())
                .map(|ip| ip.to_string());
        proto::Addresses {
            ip,
            desktop_url: None,
        }
    }
}

fn machine_to(m: proto::MachineType) -> ori_providers::reconcile::MachineType {
    use ori_providers::reconcile::MachineType as R;
    match m {
        proto::MachineType::Small => R::Small,
        proto::MachineType::Default => R::Default,
        proto::MachineType::Large => R::Large,
    }
}

fn stop_mode_to(m: proto::StopMode) -> ori_providers::reconcile::StopMode {
    match m {
        proto::StopMode::Snapshot => ori_providers::reconcile::StopMode::Snapshot,
        proto::StopMode::Force => ori_providers::reconcile::StopMode::Force,
    }
}

fn status_from(s: ori_providers::reconcile::InstanceStatus) -> proto::InstanceStatus {
    match s {
        ori_providers::reconcile::InstanceStatus::Running => proto::InstanceStatus::Running,
        ori_providers::reconcile::InstanceStatus::Stopped => proto::InstanceStatus::Stopped,
        // Unknown is "cannot tell" — the server treats that as gone so a
        // missing container surfaces as `error`, never a false ready.
        ori_providers::reconcile::InstanceStatus::Unknown => proto::InstanceStatus::Missing,
    }
}

fn map_err(e: ori_providers::Error) -> proto::ProviderError {
    use ori_providers::Error as R;
    match e {
        R::NotFound(m) => proto::ProviderError::NotFound(m),
        R::Conflict(m) => proto::ProviderError::AlreadyExists(m),
        R::QuotaExceeded(m) | R::InvalidTransition(m) | R::InvalidRequest(m) => {
            proto::ProviderError::Failed(m)
        }
        R::ProviderNotImplemented {
            provider,
            operation,
        } => proto::ProviderError::Failed(format!("{provider} has not implemented {operation}")),
        R::RateLimited(m) | R::ProviderUnavailable(m) | R::Other(m) => {
            proto::ProviderError::Unavailable(m)
        }
    }
}

#[async_trait]
impl Provider for ProxmoxAdapter {
    fn name(&self) -> &'static str {
        "proxmox"
    }

    fn capabilities(&self) -> proto::Capabilities {
        let c = self.inner.capabilities();
        proto::Capabilities {
            linked_clone: c.linked_clone,
            fs_snapshot: c.fs_snapshot,
            live_suspend: c.live_suspend,
            resize_online: c.resize_online,
            desktop: c.desktop,
            nested_containers: c.nested_containers,
            max_instances: c.max_instances,
        }
    }

    async fn capacity(&self) -> Result<proto::HostCapacity, proto::ProviderError> {
        let node = self
            .inner
            .client()
            .node_status()
            .await
            .map_err(|e| proto::ProviderError::Failed(format!("node status: {e}")))?;
        let storage = self
            .inner
            .client()
            .storage_status(&self.inner.config().storage)
            .await
            .map_err(|e| proto::ProviderError::Failed(format!("storage status: {e}")))?;
        let free_memory = node.memory.total.saturating_sub(node.memory.used);
        Ok(proto::HostCapacity {
            storage_avail_gb: storage.avail as f64 / (1024.0 * 1024.0 * 1024.0),
            free_memory_gb: free_memory as f64 / (1024.0 * 1024.0 * 1024.0),
        })
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    async fn create(
        &self,
        spec: &proto::InstanceSpec,
    ) -> Result<proto::InstanceHandle, proto::ProviderError> {
        let vmid = self.allocate_vmid().await?;
        let rspec = self.to_spec(spec, vmid);
        let h = self.inner.create(&rspec).await.map_err(map_err)?;
        Ok(proto::InstanceHandle {
            provider: h.provider,
            id: h.id,
        })
    }

    async fn clone_from(
        &self,
        src: &proto::SnapshotRef,
        spec: &proto::InstanceSpec,
    ) -> Result<proto::InstanceHandle, proto::ProviderError> {
        let vmid = self.allocate_vmid().await?;
        let rspec = self.to_spec(spec, vmid);
        let rsrc = Self::to_snapshot_ref(src);
        let h = self
            .inner
            .clone_from(&rsrc, &rspec)
            .await
            .map_err(map_err)?;
        Ok(proto::InstanceHandle {
            provider: h.provider,
            id: h.id,
        })
    }

    async fn start(&self, h: &proto::InstanceHandle) -> Result<(), proto::ProviderError> {
        self.inner.start(&Self::to_handle(h)).await.map_err(map_err)
    }

    async fn stop(
        &self,
        h: &proto::InstanceHandle,
        mode: proto::StopMode,
    ) -> Result<(), proto::ProviderError> {
        self.inner
            .stop(&Self::to_handle(h), stop_mode_to(mode))
            .await
            .map_err(map_err)
    }

    async fn destroy(&self, h: &proto::InstanceHandle) -> Result<(), proto::ProviderError> {
        self.inner
            .destroy(&Self::to_handle(h))
            .await
            .map_err(map_err)
    }

    async fn status(
        &self,
        h: &proto::InstanceHandle,
    ) -> Result<proto::InstanceStatus, proto::ProviderError> {
        self.inner
            .status(&Self::to_handle(h))
            .await
            .map(status_from)
            .map_err(map_err)
    }

    async fn snapshot(
        &self,
        h: &proto::InstanceHandle,
        name: &str,
    ) -> Result<proto::SnapshotRef, proto::ProviderError> {
        let s = self
            .inner
            .snapshot(&Self::to_handle(h), name)
            .await
            .map_err(map_err)?;
        Ok(Self::from_snapshot_ref(s))
    }

    async fn rollback(
        &self,
        h: &proto::InstanceHandle,
        s: &proto::SnapshotRef,
    ) -> Result<(), proto::ProviderError> {
        self.inner
            .rollback(&Self::to_handle(h), &Self::to_snapshot_ref(s))
            .await
            .map_err(map_err)
    }

    async fn snapshot_delete(&self, s: &proto::SnapshotRef) -> Result<(), proto::ProviderError> {
        self.inner
            .snapshot_delete(&Self::to_snapshot_ref(s))
            .await
            .map_err(map_err)
    }

    async fn exec(
        &self,
        h: &proto::InstanceHandle,
        req: &proto::ExecRequest,
    ) -> Result<proto::ExecResult, proto::ProviderError> {
        let rreq = Self::to_exec_req(req);
        let r = self
            .inner
            .exec(&Self::to_handle(h), rreq)
            .await
            .map_err(map_err)?;
        Ok(Self::from_exec_result(r))
    }

    async fn resize(
        &self,
        h: &proto::InstanceHandle,
        t: proto::MachineType,
    ) -> Result<(), proto::ProviderError> {
        self.inner
            .resize(&Self::to_handle(h), machine_to(t))
            .await
            .map_err(map_err)
    }

    async fn addresses(
        &self,
        h: &proto::InstanceHandle,
    ) -> Result<proto::Addresses, proto::ProviderError> {
        let a = self
            .inner
            .addresses(&Self::to_handle(h))
            .await
            .map_err(map_err)?;
        Ok(Self::from_addresses(a))
    }
}
