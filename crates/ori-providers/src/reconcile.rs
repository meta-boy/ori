//! # TODO(reconcile): mirror of `ori-proto`'s `Provider` trait + domain types.
//!
//! Another agent owns `crates/ori-proto` and is writing these exact types
//! right now. That crate has no `lib` target yet, so this crate cannot depend
//! on it and still build. Until C1 lands, this module duplicates the signatures
//! from `docs/ARCHITECTURE.md` **verbatim** so `ori-providers` compiles and is
//! unit-testable standalone.
//!
//! Reconciliation, when `ori-proto` exists:
//! 1. Add `ori-proto = { path = "../ori-proto" }` to `Cargo.toml`.
//! 2. Replace this module's bodies with `pub use ori_proto::{...}` re-exports.
//! 3. Delete everything below the re-export block. The `impl Provider for
//!    ProxmoxProvider` in `proxmox/mod.rs` does not change.
//!
//! Do not add or rename methods here without updating `docs/ARCHITECTURE.md`.

use std::time::Duration;

pub use async_trait::async_trait;

/// What a backend can actually do. The server degrades against this rather than
/// assuming a capability that a provider never claimed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    /// O(1) clone from a snapshot (linked clone, image layers, etc).
    pub linked_clone: bool,
    /// Filesystem snapshot while the instance is running.
    pub fs_snapshot: bool,
    /// Memory-state suspend/resume (CRIU, VM pause).
    pub live_suspend: bool,
    pub resize_online: bool,
    /// Graphical desktop via a guest-side VNC/WebRTC tunnel.
    pub desktop: bool,
    /// docker-in-sandbox.
    pub nested_containers: bool,
    pub max_instances: Option<u32>,
}

/// Machine sizing. `small|default|large` maps to (vcpu, memoryGB,
/// billingMultiplier). One source of truth; nothing else restates these numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachineType {
    Small,
    Default,
    Large,
}

impl MachineType {
    /// Note: receivers are `&self` so provider code compiles even if the enum
    /// is not `Copy` (reconciliation-proof against C1's choice).
    pub const fn vcpu(&self) -> u32 {
        match self {
            MachineType::Small => 2,
            MachineType::Default => 4,
            MachineType::Large => 8,
        }
    }

    pub const fn memory_gb(&self) -> u32 {
        match self {
            MachineType::Small => 4,
            MachineType::Default => 8,
            MachineType::Large => 16,
        }
    }

    pub const fn billing_multiplier(&self) -> f32 {
        match self {
            MachineType::Small => 0.5,
            MachineType::Default => 1.0,
            MachineType::Large => 2.0,
        }
    }
}

/// How to power an instance off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopMode {
    /// Filesystem snapshot first, then power off. Non-lossy.
    Snapshot,
    /// Power off immediately, skipping the snapshot. Data-losing, matches
    /// `ori stop --force`.
    Force,
}

/// Everything the provider needs to materialize an instance. The caller owns
/// the identity fields (id, vmid) — the provider never allocates them itself.
#[derive(Debug, Clone)]
pub struct InstanceSpec {
    /// Caller-allocated instance id.
    pub id: String,
    /// Caller-allocated Proxmox VMID (100..=999_999_999). Allocated from the
    /// server's own counter with a uniqueness constraint; the provider only
    /// cross-checks it against `/cluster/nextid`.
    pub vmid: u32,
    /// Human label, used as the container hostname.
    pub name: String,
    pub machine_type: MachineType,
    /// Proxmox template volid, e.g. `local:vztmpl/alpine-3.20-default_amd64.tar.xz`.
    pub template: String,
    /// Storage on the node, e.g. `local-lvm`. Must be snapshot-capable.
    pub storage: String,
    /// Environment the instance belongs to (for the warm-pool key). Provider
    /// ignores it today; the server uses it to pick a golden snapshot.
    pub environment: Option<String>,
    /// Environment version the instance belongs to (warm-pool key).
    pub environment_version: Option<u32>,
}

/// Opaque provider-scoped handle. `id` is only meaningful to the provider that
/// created it; the server stores it in SQLite as-is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceHandle {
    pub provider: String,
    pub id: String,
}

/// Opaque provider-scoped snapshot reference. `id` is only meaningful to the
/// provider that created it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRef {
    pub provider: String,
    pub id: String,
    /// Human-friendly snapshot name.
    pub name: String,
}

/// Provider-side view of instance state. Coarser than the server state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceStatus {
    Running,
    Stopped,
    Unknown,
}

/// A command to run inside an instance.
#[derive(Debug, Clone)]
pub struct ExecRequest {
    /// argv, e.g. `["pwd"]` or `["sh", "-c", "curl ..."]`.
    pub command: Vec<String>,
    pub timeout: Option<Duration>,
    pub env: Vec<(String, String)>,
    pub workdir: Option<String>,
}

/// Result of running a command inside an instance.
#[derive(Debug, Clone)]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub duration: Duration,
}

/// Network addresses of an instance, as observed by the provider.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Addresses {
    pub v4: Vec<std::net::IpAddr>,
    pub v6: Vec<std::net::IpAddr>,
    pub hostname: Option<String>,
}

/// Provider error taxonomy. The server maps each variant to an HTTP status +
/// JSON error body (see `docs/ARCHITECTURE.md` §Error taxonomy).
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("quota exceeded: {0}")]
    QuotaExceeded(String),
    #[error("rate limited: {0}")]
    RateLimited(String),
    #[error("provider unavailable: {0}")]
    ProviderUnavailable(String),
    #[error("invalid transition: {0}")]
    InvalidTransition(String),
    #[error("provider {provider} has not implemented {operation}")]
    ProviderNotImplemented {
        provider: &'static str,
        operation: &'static str,
    },
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("{0}")]
    Other(String),
}

/// The abstraction every backend implements. Idempotency contract: every method
/// is idempotent or explicitly documented as not, because the TTL reaper and
/// the pool manager race on the same instance.
#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities;

    /// Cold create from a template, then start. **Not idempotent** — a second
    /// create for the same `vmid` conflicts.
    async fn create(&self, spec: &InstanceSpec) -> Result<InstanceHandle, Error>;

    /// Linked clone from a snapshot. The clone is left **stopped**; the caller
    /// starts it (the warm pool and fork both start explicitly). **Not
    /// idempotent** — a second clone to the same `vmid` conflicts.
    async fn clone_from(
        &self,
        src: &SnapshotRef,
        spec: &InstanceSpec,
    ) -> Result<InstanceHandle, Error>;

    /// Idempotent: starting an already-running instance is `Ok`.
    async fn start(&self, h: &InstanceHandle) -> Result<(), Error>;

    /// `StopMode::Snapshot` snapshots then powers off; `Force` skips the
    /// snapshot. Idempotent: stopping an already-stopped instance is `Ok`.
    async fn stop(&self, h: &InstanceHandle, mode: StopMode) -> Result<(), Error>;

    /// Idempotent: destroying a missing instance is `Ok`.
    async fn destroy(&self, h: &InstanceHandle) -> Result<(), Error>;

    async fn status(&self, h: &InstanceHandle) -> Result<InstanceStatus, Error>;

    /// Filesystem snapshot of a (possibly running) instance.
    async fn snapshot(&self, h: &InstanceHandle, name: &str) -> Result<SnapshotRef, Error>;

    /// Management operation, never a request-path one. Measured ~47 s for an
    /// LXC to become executable afterwards. `resume`/`fork` must not call it.
    async fn rollback(&self, h: &InstanceHandle, s: &SnapshotRef) -> Result<(), Error>;

    /// Idempotent: deleting a missing snapshot is `Ok`.
    async fn snapshot_delete(&self, s: &SnapshotRef) -> Result<(), Error>;

    /// The primary exec path is the guest agent over the control-plane tunnel
    /// (server-side, C6). Providers offer this as the bootstrap-only fallback
    /// and must document what it is.
    async fn exec(&self, h: &InstanceHandle, req: ExecRequest) -> Result<ExecResult, Error>;

    /// Change cpu/memory to a target machine type. `resize_online: false`
    /// providers apply it on the next start.
    async fn resize(&self, h: &InstanceHandle, t: MachineType) -> Result<(), Error>;

    /// Best-effort current addresses. May be empty shortly after start; callers
    /// poll with a deadline.
    async fn addresses(&self, h: &InstanceHandle) -> Result<Addresses, Error>;
}
