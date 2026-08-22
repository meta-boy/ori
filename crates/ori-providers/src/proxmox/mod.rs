//! Proxmox LXC backend (`Provider` impl) over the PVE REST API.
//!
//! - Auth: token header `Authorization: PVEAPIToken=user@realm!tokenid=secret`.
//! - Self-signed certs: configure a CA PEM or set `insecure_skip_verify`
//!   (off by default; when on, logged loudly).
//! - **Every mutating call returns a UPID and HTTP 200 only means queued.**
//!   All mutations route through [`PveClient::wait_task`], which polls the
//!   task to completion and checks `exitstatus == "OK"`.
//!
//! Operation mapping (from `docs/ARCHITECTURE.md`):
//!
//! | `Provider` | PVE call |
//! |---|---|
//! | `create` | `POST /nodes/{n}/lxc` (unprivileged, nesting=1, bridged DHCP), then start |
//! | `clone_from` | `POST /nodes/{n}/lxc/{vmid}/clone` with **`full=0`** + `snapname=` |
//! | `snapshot` | `POST .../snapshot` |
//! | `rollback` | `POST .../snapshot/{name}/rollback` (admin-only) |
//! | `stop` | snapshot then `POST .../status/stop` |
//! | `start` | `POST .../status/start` |
//! | `destroy` | `DELETE /nodes/{n}/lxc/{vmid}` |
//! | `resize` | `PUT .../config` (cores, memory) |
//! | `exec` | **bootstrap-only** `pct exec` over SSH (guest agent is primary, C6) |
//!
//! Capabilities are declared honestly: linked clone yes, fs snapshot yes,
//! `live_suspend: false` (CRIU measured failing on the target kernel — do not
//! implement it), nested containers yes, resize online no, desktop yes.

pub mod client;
pub mod dto;
pub mod error;
pub mod exec;
pub mod handle;

use std::time::Duration;

use async_trait::async_trait;
use reqwest::ClientBuilder;

pub use client::PveClient;
pub use error::PveError;
pub use exec::PctExec;
pub use handle::{handle_for, handle_id, parse_handle, parse_snapshot_ref, snapshot_ref_for};

use crate::reconcile::{
    Addresses, Capabilities, Error, ExecRequest, ExecResult, InstanceHandle, InstanceSpec,
    InstanceStatus, MachineType, Provider, SnapshotRef, StopMode,
};

use dto::Interface;

/// Default task-completion timeout (create/clone/start/stop/destroy/snapshot).
pub const TASK_TIMEOUT: Duration = Duration::from_secs(300);
/// How long to wait for a container to reach `running` after a start task.
const START_RUNNING_TIMEOUT: Duration = Duration::from_secs(120);
/// How long to wait for a container to reach `stopped` after a stop task.
const STOP_STOPPED_TIMEOUT: Duration = Duration::from_secs(120);
/// How long to wait for an address to appear after start. Measured: DHCP is up
/// ~0.85 s after the container starts; 30 s covers pathological cases.
const ADDRESS_DEADLINE: Duration = Duration::from_secs(30);
/// Rootfs size in GB for cold creates.
const ROOTFS_SIZE_GB: u32 = 8;

/// Configuration for the Proxmox provider. `serde`-deserializable so the
/// server can construct it from JSON config.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProxmoxConfig {
    /// PVE origin, e.g. `https://10.0.0.5:8006`.
    pub host: String,
    /// `user@realm!tokenid`.
    pub token_id: String,
    pub token_secret: String,
    /// Node all operations run against.
    pub node: String,
    /// Snapshot-capable storage (LVM-thin or ZFS). `dir` is refused at startup.
    pub storage: String,
    /// Template volid for cold creates, e.g.
    /// `local:vztmpl/alpine-3.20-default_amd64.tar.xz`.
    pub template: String,
    /// Bridge for the container's `eth0`, e.g. `vmbr0`.
    pub bridge: String,
    /// CA PEM bytes to trust in addition to the system store.
    #[serde(default)]
    pub ca_pem: Option<String>,
    /// Path to a CA PEM file to trust in addition to the system store.
    #[serde(default)]
    pub ca_pem_file: Option<std::path::PathBuf>,
    /// Disable TLS certificate verification. Off by default; when on, logged
    /// loudly. For self-signed certs, prefer `ca_pem`/`ca_pem_file`.
    #[serde(default)]
    pub insecure_skip_verify: bool,
    /// `user@host` plus any flags, e.g. `root@10.0.0.5 -p 2222`, used by the
    /// bootstrap-only `exec` fallback (`pct exec` over SSH). `None` disables
    /// provider `exec`.
    #[serde(default)]
    pub ssh: Option<String>,
    /// Optional identity file for the `exec` SSH fallback.
    #[serde(default)]
    pub ssh_identity_file: Option<std::path::PathBuf>,
    /// Task-completion timeout in seconds (default 300).
    #[serde(default = "default_task_timeout_secs")]
    pub task_timeout_secs: u64,
}

fn default_task_timeout_secs() -> u64 {
    300
}

impl ProxmoxConfig {
    /// Build from `ORI_PVE_*` environment variables (used by integration tests
    /// and the conformance suite).
    pub fn from_env() -> Result<Self, Error> {
        fn env(name: &str) -> Result<String, Error> {
            std::env::var(name)
                .map_err(|_| Error::InvalidRequest(format!("missing environment variable {name}")))
        }
        Ok(ProxmoxConfig {
            host: env("ORI_PVE_HOST")?,
            token_id: env("ORI_PVE_TOKEN_ID")?,
            token_secret: env("ORI_PVE_TOKEN_SECRET")?,
            node: env("ORI_PVE_NODE")?,
            storage: env("ORI_PVE_STORAGE")?,
            template: env("ORI_PVE_TEMPLATE_ALPINE")?,
            bridge: env("ORI_PVE_BRIDGE")?,
            ca_pem: None,
            ca_pem_file: None,
            insecure_skip_verify: false,
            ssh: std::env::var("ORI_PVE_SSH").ok(),
            ssh_identity_file: None,
            task_timeout_secs: default_task_timeout_secs(),
        })
    }
}

/// The Proxmox backend.
#[derive(Clone)]
pub struct ProxmoxProvider {
    client: PveClient,
    config: ProxmoxConfig,
}

impl ProxmoxProvider {
    /// Build the HTTP client (rustls, optional CA, loud insecure flag) and run
    /// startup preflight. Failing fast here beats a mystery failure on the
    /// first `fork`.
    pub async fn new(config: ProxmoxConfig) -> Result<Self, Error> {
        if config.insecure_skip_verify {
            tracing::warn!(
                "proxmox: insecure_skip_verify is ON — TLS certificate verification is disabled for {}",
                config.host
            );
        }

        let mut builder = ClientBuilder::new()
            .use_rustls_tls()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60));
        if config.insecure_skip_verify {
            builder = builder.danger_accept_invalid_certs(true);
        }
        if let Some(pem) = &config.ca_pem {
            let cert = reqwest::Certificate::from_pem(pem.as_bytes()).map_err(|e| {
                Error::InvalidRequest(format!("invalid ca_pem: {e}"))
            })?;
            builder = builder.add_root_certificate(cert);
        }
        if let Some(path) = &config.ca_pem_file {
            let pem = std::fs::read(path).map_err(|e| {
                Error::InvalidRequest(format!("cannot read ca_pem_file {:?}: {e}", path))
            })?;
            let cert = reqwest::Certificate::from_pem(&pem)
                .map_err(|e| Error::InvalidRequest(format!("invalid ca_pem_file {:?}: {e}", path)))?;
            builder = builder.add_root_certificate(cert);
        }

        let http = builder.build().map_err(|e| {
            Error::InvalidRequest(format!("cannot build http client: {e}"))
        })?;
        Self::new_with_client(config, http).await
    }

    /// Build without building an HTTP client (tests inject a mock client).
    pub async fn new_with_client(config: ProxmoxConfig, http: reqwest::Client) -> Result<Self, Error> {
        let client = PveClient::new(&config, http);
        let provider = Self { client, config };
        provider.preflight().await?;
        Ok(provider)
    }

    pub fn config(&self) -> &ProxmoxConfig {
        &self.config
    }

    /// Startup preflight: node exists and is online, storage can snapshot
    /// (LVM-thin or ZFS only — `dir` is refused), the template exists, and the
    /// token can create. The storage refusal is the point of the plan: a clear
    /// startup error beats a mysterious failure on the first fork.
    async fn preflight(&self) -> Result<(), PveError> {
        let nodes = self.client.nodes().await?;
        let node = nodes
            .iter()
            .find(|n| n.node == self.client.node)
            .ok_or_else(|| PveError::NodeMissing {
                node: self.client.node.clone(),
            })?;
        if node.status.as_deref() != Some("online") {
            return Err(PveError::NodeNotOnline {
                node: self.client.node.clone(),
                status: node.status.clone().unwrap_or_default(),
            });
        }

        let storages = self.client.storages().await?;
        let storage = storages
            .iter()
            .find(|s| s.storage == self.config.storage)
            .ok_or_else(|| PveError::StorageMissing {
                node: self.client.node.clone(),
                storage: self.config.storage.clone(),
            })?;
        match storage.kind.as_str() {
            "lvmthin" | "zfspool" => {}
            kind => {
                return Err(PveError::StorageNotSnapshotCapable {
                    storage: self.config.storage.clone(),
                    kind: kind.to_string(),
                });
            }
        }

        let (tpl_storage, _) = self
            .config
            .template
            .split_once(':')
            .ok_or_else(|| PveError::Config(format!("template {:?} has no storage: prefix", self.config.template)))?;
        let content = self
            .client
            .storage_content(tpl_storage, "vztmpl")
            .await?;
        if !content.iter().any(|c| c.volid == self.config.template) {
            return Err(PveError::TemplateMissing {
                node: self.client.node.clone(),
                storage: tpl_storage.to_string(),
                template: self.config.template.clone(),
            });
        }

        self.verify_can_create().await?;
        Ok(())
    }

    /// The token must be able to allocate a VMID and create containers.
    /// `/cluster/nextid` requires `VM.Allocate`; the permissions dump is then
    /// scanned for create/configure privileges.
    async fn verify_can_create(&self) -> Result<(), PveError> {
        let nextid = self.client.nextid().await?;
        if nextid < 100 {
            return Err(PveError::Config(format!("unexpected nextid {nextid}")));
        }
        let user = self
            .config
            .token_id
            .split('!')
            .next()
            .ok_or_else(|| PveError::Config(format!("token_id {:?} has no user part", self.config.token_id)))?;
        let path = format!("access/permissions?userid={user}");
        let text = self
            .client
            .get_raw_text(&path)
            .await
            .map_err(|e| PveError::Config(format!("cannot read permissions for {user}: {e}")))?;
        let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
            PveError::Data(format!("permissions response for {user}: {e}"))
        })?;
        let data = value.get("data").ok_or_else(|| {
            PveError::Data(format!("permissions response has no data for {user}"))
        })?;

        let required = ["VM.Allocate", "VM.Clone", "VM.Config.Disk", "VM.Config.Memory", "VM.Config.CPU"];
        let mut have: Vec<&str> = Vec::new();
        let mut allowed = data
            .as_object()
            .into_iter()
            .flat_map(|map| map.values())
            .flat_map(|perms| perms.as_object().into_iter().flat_map(|p| p.keys()))
            .filter_map(|k| k.as_str())
            .filter(|k| required.contains(k));
        for priv_ in allowed.by_ref() {
            have.push(priv_);
        }
        if !have.iter().any(|p| *p == "VM.Allocate")
            || !have.iter().any(|p| p.starts_with("VM.Config."))
            || !have.contains(&"VM.Clone")
        {
            return Err(PveError::Config(format!(
                "token {user} cannot create containers; has {have:?}, needs VM.Allocate + VM.Config.* + VM.Clone"
            )));
        }
        Ok(())
    }

    fn task_timeout(&self) -> Duration {
        Duration::from_secs(self.config.task_timeout_secs.max(1))
    }

    /// Cross-check a caller-allocated VMID against `/cluster/nextid`. The
    /// caller owns the counter (SQLite uniqueness constraint); this just
    /// catches a caller that reuses an id that is already taken.
    async fn ensure_vmid_free(&self, vmid: u32) -> Result<(), PveError> {
        if !(100..=999_999_999).contains(&vmid) {
            return Err(PveError::VmidOutOfRange { vmid });
        }
        let nextid = self.client.nextid().await?;
        if vmid < nextid {
            return Err(PveError::VmidCollision { vmid, nextid });
        }
        Ok(())
    }

    /// Start a VM, waiting until it is actually `running`. Idempotent.
    async fn start_vm(&self, vmid: u32) -> Result<(), PveError> {
        let st = self.client.vm_status(vmid).await?;
        if st.status == "running" {
            return Ok(());
        }
        let upid = self.client.start_lxc(vmid).await?;
        self.client.wait_task(&upid, self.task_timeout()).await?;
        self.client
            .wait_vm_status(vmid, "running", START_RUNNING_TIMEOUT)
            .await
    }

    /// Stop a VM. `mode == Snapshot` snapshots first (skip only on
    /// `StopMode::Force`). Idempotent when already stopped.
    async fn stop_vm(&self, vmid: u32, mode: StopMode) -> Result<(), PveError> {
        let st = self.client.vm_status(vmid).await?;
        if st.status == "stopped" {
            return Ok(());
        }
        if mode == StopMode::Snapshot {
            let name = format!(
                "stop-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0)
            );
            let upid = self.client.snapshot_lxc(vmid, &name).await?;
            self.client.wait_task(&upid, self.task_timeout()).await?;
        }
        let upid = self.client.stop_lxc(vmid).await?;
        self.client.wait_task(&upid, self.task_timeout()).await?;
        self.client
            .wait_vm_status(vmid, "stopped", STOP_STOPPED_TIMEOUT)
            .await
    }

    /// Poll `/interfaces` until a non-loopback address appears or the deadline
    /// passes. A container's IP is not available the instant it starts.
    async fn addresses_with_deadline(&self, vmid: u32) -> Result<Addresses, PveError> {
        let st = self.client.vm_status(vmid).await?;
        let hostname = st.name;
        let deadline = tokio::time::Instant::now() + ADDRESS_DEADLINE;
        loop {
            let ifs = self.client.interfaces(vmid).await?;
            let addrs = Self::collect_addresses(&ifs, hostname.clone());
            if !addrs.v4.is_empty() || tokio::time::Instant::now() >= deadline {
                return Ok(addrs);
            }
            tokio::time::sleep(client::VM_POLL_INTERVAL).await;
        }
    }

    fn collect_addresses(ifs: &[Interface], hostname: Option<String>) -> Addresses {
        let mut v4: Vec<std::net::IpAddr> = Vec::new();
        let mut v6: Vec<std::net::IpAddr> = Vec::new();
        for iface in ifs {
            for ip in &iface.ip_addresses {
                let addr: std::net::IpAddr = match ip.ip.parse() {
                    Ok(a) => a,
                    Err(_) => continue,
                };
                if addr.is_loopback() {
                    continue;
                }
                match ip.kind.as_str() {
                    "inet" => {
                        if !v4.contains(&addr) {
                            v4.push(addr);
                        }
                    }
                    "inet6" => {
                        if !v6.contains(&addr) {
                            v6.push(addr);
                        }
                    }
                    _ => {}
                }
            }
            Self::push_cidr(&mut v4, iface.inet.as_deref());
            Self::push_cidr(&mut v6, iface.inet6.as_deref());
        }
        Addresses { v4, v6, hostname }
    }

    fn push_cidr(out: &mut Vec<std::net::IpAddr>, cidr: Option<&str>) {
        let Some(cidr) = cidr else { return };
        for part in cidr.split(',') {
            let ip_part = part.split('/').next().unwrap_or(part);
            if let Ok(addr) = ip_part.parse::<std::net::IpAddr>() {
                if !addr.is_loopback() && !out.contains(&addr) {
                    out.push(addr);
                }
            }
        }
    }

    /// Map a PVE low-level error into the shared provider error taxonomy.
    fn map_err(e: PveError) -> Error {
        match e {
            PveError::Http { status, path, body } => match status.as_u16() {
                404 => Error::NotFound(format!("{path}: {body}")),
                409 => Error::Conflict(format!("{path}: {body}")),
                429 => Error::RateLimited(format!("{path}: {body}")),
                401 | 403 => Error::ProviderUnavailable(format!("{path}: {body}")),
                _ => Error::ProviderUnavailable(format!("{status} {path}: {body}")),
            },
            PveError::TaskFailed { upid, reason } => {
                Error::ProviderUnavailable(format!("task {upid} failed: {reason}"))
            }
            PveError::TaskTimeout { upid, timeout } => {
                Error::ProviderUnavailable(format!("task {upid} did not finish within {timeout:?}"))
            }
            PveError::StateTimeout { handle, want, timeout } => Error::ProviderUnavailable(format!(
                "{handle} did not reach {want} within {timeout:?}"
            )),
            PveError::NodeMissing { node } => Error::NotFound(format!("node {node}")),
            PveError::NodeNotOnline { node, status } => {
                Error::ProviderUnavailable(format!("node {node} not online (status {status})"))
            }
            PveError::StorageNotSnapshotCapable { storage, kind } => Error::InvalidRequest(
                format!("storage {storage} ({kind}) cannot snapshot; use LVM-thin or ZFS"),
            ),
            PveError::StorageMissing { node, storage } => {
                Error::NotFound(format!("storage {storage} on {node}"))
            }
            PveError::TemplateMissing { node, storage, template } => Error::NotFound(format!(
                "template {template} on {node}/{storage}"
            )),
            PveError::VmidCollision { vmid, nextid } => Error::Conflict(format!(
                "vmid {vmid} already allocated (next free {nextid}); caller must allocate from its own counter"
            )),
            PveError::VmidOutOfRange { vmid } => {
                Error::InvalidRequest(format!("vmid {vmid} out of range 100..=999_999_999"))
            }
            PveError::SnapshotNodeMismatch { id, node } => {
                Error::InvalidRequest(format!("snapshot {id} not on configured node {node}"))
            }
            PveError::MalformedHandle(id) => Error::InvalidRequest(format!("malformed handle {id}")),
            PveError::MalformedSnapshotRef(id) => {
                Error::InvalidRequest(format!("malformed snapshot ref {id}"))
            }
            PveError::WrongProvider(p) => {
                Error::InvalidRequest(format!("handle belongs to provider {p}"))
            }
            PveError::Exec(msg) => Error::ProviderUnavailable(format!("exec: {msg}")),
            PveError::Config(msg) => Error::InvalidRequest(msg),
            PveError::Data(msg) => Error::ProviderUnavailable(msg),
            PveError::UnexpectedResponse { path, body } => {
                Error::ProviderUnavailable(format!("unexpected response from {path}: {body}"))
            }
            PveError::Transport { path, source } => {
                Error::ProviderUnavailable(format!("request to {path} failed: {source}"))
            }
            PveError::Io(e) => Error::Other(e.to_string()),
        }
    }
}

#[async_trait]
impl Provider for ProxmoxProvider {
    fn name(&self) -> &'static str {
        "proxmox"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            linked_clone: true,
            fs_snapshot: true,
            live_suspend: false,
            resize_online: false,
            desktop: true,
            nested_containers: true,
            max_instances: None,
        }
    }

    /// Cold create from the template, then start. Not idempotent: the same
    /// `vmid` twice conflicts.
    async fn create(&self, spec: &InstanceSpec) -> Result<InstanceHandle, Error> {
        self.ensure_vmid_free(spec.vmid).await.map_err(Self::map_err)?;
        let form = vec![
            ("vmid".to_string(), spec.vmid.to_string()),
            ("ostemplate".to_string(), spec.template.clone()),
            ("storage".to_string(), spec.storage.clone()),
            ("hostname".to_string(), spec.name.clone()),
            ("cores".to_string(), spec.machine_type.vcpu().to_string()),
            (
                "memory".to_string(),
                (spec.machine_type.memory_gb() * 1024).to_string(),
            ),
            ("unprivileged".to_string(), "1".to_string()),
            ("features".to_string(), "nesting=1".to_string()),
            (
                "net0".to_string(),
                format!("name=eth0,bridge={},ip=dhcp,type=veth", self.config.bridge),
            ),
            ("rootfs".to_string(), format!("{}:{ROOTFS_SIZE_GB}", spec.storage)),
            ("description".to_string(), format!("ori instance {}", spec.id)),
        ];
        let upid = self
            .client
            .create_lxc(&form)
            .await
            .map_err(Self::map_err)?;
        self.client
            .wait_task(&upid, self.task_timeout())
            .await
            .map_err(Self::map_err)?;
        self.start_vm(spec.vmid).await.map_err(Self::map_err)?;
        Ok(handle_for(&self.client.node, spec.vmid))
    }

    /// Linked clone (`full=0`) from a snapshot. The clone is left **stopped**;
    /// the caller starts it. Not idempotent.
    async fn clone_from(
        &self,
        src: &SnapshotRef,
        spec: &InstanceSpec,
    ) -> Result<InstanceHandle, Error> {
        let (src_node, src_vmid, snap_name) =
            parse_snapshot_ref(src).map_err(Self::map_err)?;
        if src_node != self.client.node {
            return Err(Self::map_err(PveError::SnapshotNodeMismatch {
                id: src.id.clone(),
                node: self.client.node.clone(),
            }));
        }
        self.ensure_vmid_free(spec.vmid).await.map_err(Self::map_err)?;
        let form = vec![
            ("newid".to_string(), spec.vmid.to_string()),
            // Linked clone on LVM-thin: ~1.7 s and O(1) in disk size. A full
            // clone is 2× slower and PVE refuses it on a running container.
            ("full".to_string(), "0".to_string()),
            ("snapname".to_string(), snap_name),
            ("hostname".to_string(), spec.name.clone()),
            ("storage".to_string(), spec.storage.clone()),
            ("description".to_string(), format!("ori clone of {src_vmid}")),
        ];
        let upid = self
            .client
            .clone_lxc(src_vmid, &form)
            .await
            .map_err(Self::map_err)?;
        self.client
            .wait_task(&upid, self.task_timeout())
            .await
            .map_err(Self::map_err)?;
        Ok(handle_for(&self.client.node, spec.vmid))
    }

    /// Idempotent: starting a running instance is `Ok`.
    async fn start(&self, h: &InstanceHandle) -> Result<(), Error> {
        let (_, vmid) = parse_handle(h).map_err(Self::map_err)?;
        self.start_vm(vmid).await.map_err(Self::map_err)
    }

    /// `StopMode::Snapshot` snapshots then powers off; `Force` skips the
    /// snapshot. Idempotent on an already-stopped instance.
    async fn stop(&self, h: &InstanceHandle, mode: StopMode) -> Result<(), Error> {
        let (_, vmid) = parse_handle(h).map_err(Self::map_err)?;
        self.stop_vm(vmid, mode).await.map_err(Self::map_err)
    }

    /// Idempotent: destroying a missing instance is `Ok`.
    async fn destroy(&self, h: &InstanceHandle) -> Result<(), Error> {
        let (_, vmid) = parse_handle(h).map_err(Self::map_err)?;
        match self.client.destroy_lxc(vmid).await {
            Ok(upid) => self
                .client
                .wait_task(&upid, self.task_timeout())
                .await
                .map_err(Self::map_err),
            Err(PveError::Http { status, .. }) if status.as_u16() == 404 => Ok(()),
            Err(e) => Err(Self::map_err(e)),
        }
    }

    async fn status(&self, h: &InstanceHandle) -> Result<InstanceStatus, Error> {
        let (_, vmid) = parse_handle(h).map_err(Self::map_err)?;
        let st = self.client.vm_status(vmid).await.map_err(Self::map_err)?;
        Ok(match st.status.as_str() {
            "running" => InstanceStatus::Running,
            "stopped" => InstanceStatus::Stopped,
            _ => InstanceStatus::Unknown,
        })
    }

    async fn snapshot(&self, h: &InstanceHandle, name: &str) -> Result<SnapshotRef, Error> {
        let (node, vmid) = parse_handle(h).map_err(Self::map_err)?;
        let upid = self
            .client
            .snapshot_lxc(vmid, name)
            .await
            .map_err(Self::map_err)?;
        self.client
            .wait_task(&upid, self.task_timeout())
            .await
            .map_err(Self::map_err)?;
        Ok(snapshot_ref_for(&node, vmid, name))
    }

    /// Admin/management only. Measured: an LXC takes ~47 s to become
    /// executable after a rollback (LVM-thin drops and recreates the LV).
    /// `resume` and `fork` must not use it; they use linked clone instead.
    async fn rollback(&self, h: &InstanceHandle, s: &SnapshotRef) -> Result<(), Error> {
        let (_, vmid) = parse_handle(h).map_err(Self::map_err)?;
        let (_, _, name) = parse_snapshot_ref(s).map_err(Self::map_err)?;
        let upid = self
            .client
            .rollback_lxc(vmid, &name)
            .await
            .map_err(Self::map_err)?;
        self.client
            .wait_task(&upid, self.task_timeout())
            .await
            .map_err(Self::map_err)
    }

    /// Idempotent: deleting a missing snapshot is `Ok`.
    async fn snapshot_delete(&self, s: &SnapshotRef) -> Result<(), Error> {
        let (_, vmid, name) = parse_snapshot_ref(s).map_err(Self::map_err)?;
        match self.client.snapshot_delete(vmid, &name).await {
            Ok(upid) => self
                .client
                .wait_task(&upid, self.task_timeout())
                .await
                .map_err(Self::map_err),
            Err(PveError::Http { status, .. }) if status.as_u16() == 404 => Ok(()),
            Err(e) => Err(Self::map_err(e)),
        }
    }

    /// **Bootstrap-only fallback.** The primary exec path is the guest agent
    /// over the control-plane tunnel (C6); this runs `pct exec` over SSH and is
    /// only correct before the agent is up. Requires `config.ssh`; otherwise
    /// exec is unavailable from the provider.
    async fn exec(&self, h: &InstanceHandle, req: ExecRequest) -> Result<ExecResult, Error> {
        let (_, vmid) = parse_handle(h).map_err(Self::map_err)?;
        let target = self.config.ssh.clone().ok_or_else(|| {
            Error::ProviderUnavailable(
                "exec: guest agent (C6) not available and ssh fallback not configured (set config.ssh)"
                    .to_string(),
            )
        })?;
        let pct = PctExec::new(target, self.config.ssh_identity_file.clone());
        pct.exec(vmid, &req).await.map_err(Self::map_err)
    }

    /// Change cores/memory to the machine type's. `resize_online: false`, so
    /// this writes the config and the change applies on the next start.
    async fn resize(&self, h: &InstanceHandle, t: MachineType) -> Result<(), Error> {
        let (_, vmid) = parse_handle(h).map_err(Self::map_err)?;
        self.client
            .resize_lxc(vmid, t.vcpu(), t.memory_gb() as u64 * 1024)
            .await
            .map_err(Self::map_err)
    }

    async fn addresses(&self, h: &InstanceHandle) -> Result<Addresses, Error> {
        let (_, vmid) = parse_handle(h).map_err(Self::map_err)?;
        self.addresses_with_deadline(vmid).await.map_err(Self::map_err)
    }
}