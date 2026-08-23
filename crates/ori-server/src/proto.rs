//! Provider-facing types, plus a re-export of the shared wire contract.
//!
//! The wire types now live in `ori-proto` (see that crate's docs for why). They
//! are re-exported here so `crate::proto::X` keeps resolving throughout the
//! server - the consolidation is a deletion of duplicates, not a rename that
//! churns every call site.

pub use ori_proto::*;

use std::collections::HashMap;
use std::fmt;

// ---------------------------------------------------------------------------
// Provider trait
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Capabilities {
    pub linked_clone: bool,
    pub fs_snapshot: bool,
    pub live_suspend: bool,
    pub resize_online: bool,
    pub desktop: bool,
    pub nested_containers: bool,
    pub max_instances: Option<u32>,
}

/// A snapshot of host capacity for the `new` capacity guard. The arithmetic is
/// the same one `scripts/preflight.sh` §6 uses (`ORI_POOL_HEADROOM_GB`): the
/// server subtracts the warm-pool footprint (`pool_depth * slot_gb`) from
/// `storage_avail_gb` and compares the resulting headroom and `free_memory_gb`
/// against the requested machine type.
#[derive(Debug, Clone, Copy)]
pub struct HostCapacity {
    /// Free thin-pool storage on the container storage, in GB (`avail` from
    /// `GET /nodes/{node}/storage/{storage}/status`).
    pub storage_avail_gb: f64,
    /// Free memory on the node, in GB (`total - used` from the node status).
    pub free_memory_gb: f64,
}

#[derive(Debug, Clone)]
pub struct InstanceSpec {
    /// Caller-allocated sandbox id, carried for providers that label their
    /// instances with it (e.g. Proxmox container descriptions).
    pub id: String,
    pub name: String,
    pub machine_type: MachineType,
    pub environment: String,
    pub environment_version: i64,
    pub env_vars: HashMap<String, String>,
}

/// Opaque, provider-scoped instance identifier stored in SQLite.
#[derive(Debug, Clone)]
pub struct InstanceHandle {
    pub provider: String,
    pub id: String,
}

impl fmt::Display for InstanceHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.provider, self.id)
    }
}

#[derive(Debug, Clone)]
pub struct SnapshotRef {
    pub provider: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct ExecRequest {
    pub cmd: Vec<String>,
    pub cwd: Option<String>,
    pub timeout_secs: Option<u64>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct ExecResult {
    pub pid: i64,
    pub completed: bool,
    pub exit_code: i64,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopMode {
    /// Snapshot first, then power off. Data-preserving.
    Snapshot,
    /// Power off immediately, losing anything since the last snapshot.
    Force,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstanceStatus {
    Running,
    Stopped,
    /// The provider no longer has this instance.
    Missing,
}

#[derive(Debug, Clone, Default)]
pub struct Addresses {
    pub ip: Option<String>,
    pub desktop_url: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("provider unavailable: {0}")]
    Unavailable(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("already exists: {0}")]
    AlreadyExists(String),
    #[error("operation failed: {0}")]
    Failed(String),
}

/// Every method is idempotent or explicitly documented as not. `stop` on a
/// stopped instance is `Ok`, not an error — the TTL reaper and request paths
/// race on the same instance.
#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities;

    /// Snapshot of host capacity for the `new` capacity guard. A provider that
    /// cannot answer is a **fail-closed** signal: `new` refuses rather than
    /// risk filling the host (the leaked-container incident that drove this).
    async fn capacity(&self) -> Result<HostCapacity, ProviderError>;

    /// Downcast hook so the server can reach provider-specific internals
    /// (e.g. enumerating instances for orphan detection) without leaking
    /// provider types through the trait.
    /// TODO(reconcile): the real `ori-proto` trait may model instance
    /// enumeration explicitly; this keeps the mock honest in the meantime.
    fn as_any(&self) -> &dyn std::any::Any;

    async fn create(&self, spec: &InstanceSpec) -> Result<InstanceHandle, ProviderError>;
    async fn clone_from(
        &self,
        src: &SnapshotRef,
        spec: &InstanceSpec,
    ) -> Result<InstanceHandle, ProviderError>;
    async fn start(&self, h: &InstanceHandle) -> Result<(), ProviderError>;
    async fn stop(&self, h: &InstanceHandle, mode: StopMode) -> Result<(), ProviderError>;
    async fn destroy(&self, h: &InstanceHandle) -> Result<(), ProviderError>;
    async fn status(&self, h: &InstanceHandle) -> Result<InstanceStatus, ProviderError>;

    async fn snapshot(&self, h: &InstanceHandle, name: &str) -> Result<SnapshotRef, ProviderError>;
    async fn rollback(&self, h: &InstanceHandle, s: &SnapshotRef) -> Result<(), ProviderError>;
    async fn snapshot_delete(&self, s: &SnapshotRef) -> Result<(), ProviderError>;

    async fn exec(
        &self,
        h: &InstanceHandle,
        req: &ExecRequest,
    ) -> Result<ExecResult, ProviderError>;
    async fn resize(&self, h: &InstanceHandle, t: MachineType) -> Result<(), ProviderError>;
    async fn addresses(&self, h: &InstanceHandle) -> Result<Addresses, ProviderError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_formats() {
        let id = TypedId::sandbox();
        assert!(id.as_str().starts_with("ori_"));
        assert_eq!(id.as_str().len(), 4 + 8);
        assert!(id.as_str()[4..]
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));

        let op = TypedId::deletion_op();
        assert!(op.as_str().starts_with("oriop_"));
        assert_eq!(op.as_str().len(), 6 + 32);
        assert!(op.as_str()[6..].chars().all(|c| c.is_ascii_hexdigit()));

        // uniqueness smoke: two draws differ
        assert_ne!(TypedId::sandbox(), TypedId::sandbox());
    }

    #[test]
    fn machine_type_numbers() {
        assert_eq!(MachineType::Small.vcpu(), 2);
        assert_eq!(MachineType::Small.memory_gb(), 4);
        assert_eq!(MachineType::Small.billing_multiplier(), 0.5);
        assert_eq!(MachineType::Default.vcpu(), 4);
        assert_eq!(MachineType::Default.memory_gb(), 8);
        assert_eq!(MachineType::Large.vcpu(), 8);
        assert_eq!(MachineType::Large.memory_gb(), 16);
    }

    #[test]
    fn wire_names() {
        assert_eq!(
            serde_json::to_string(&MachineType::Small).unwrap(),
            "\"small\""
        );
        assert_eq!(
            serde_json::to_string(&BoxState::Ready).unwrap(),
            "\"ready\""
        );
        assert_eq!(BoxState::Stopped.as_str(), "stopped");
        assert_eq!(BoxState::Ready.letter(), 'r');
        assert_eq!(BoxState::Init.letter(), 'p');
        assert_eq!(BoxState::Stopping.letter(), 't');
        assert_eq!(BoxState::Error.letter(), 'e');
    }

    #[test]
    fn rejected_transition() {
        // resume on a running sandbox must be rejected, not a silent no-op
        assert!(!BoxState::Running.can_transition_to(BoxState::Provisioning));
        assert!(!BoxState::Ready.can_transition_to(BoxState::Provisioning));
        assert!(BoxState::Stopped.can_transition_to(BoxState::Provisioning));
        assert!(BoxState::Ready.can_transition_to(BoxState::Stopping));
        assert!(BoxState::Stopping.can_transition_to(BoxState::Stopped));
    }

    #[test]
    fn event_lines_match_spec() {
        let created = StreamEvent::Created {
            id: "ori_a1b2c3d4".into(),
            ttl_seconds: Some(900),
            team: None,
        };
        assert_eq!(
            created.to_line().trim(),
            r#"{"event":"created","id":"ori_a1b2c3d4","ttlSeconds":900,"team":null}"#
        );

        let state = StreamEvent::State {
            id: "ori_a1b2c3d4".into(),
            state: "cloning".into(),
        };
        assert_eq!(
            state.to_line().trim(),
            r#"{"event":"state","id":"ori_a1b2c3d4","state":"cloning"}"#
        );

        let accepted = StreamEvent::Accepted {
            id: "ori_a1b2c3d4".into(),
            status: "resuming".into(),
        };
        assert_eq!(
            accepted.to_line().trim(),
            r#"{"event":"accepted","id":"ori_a1b2c3d4","status":"resuming"}"#
        );

        let ready = StreamEvent::Ready {
            id: "ori_a1b2c3d4".into(),
            state: "ready".into(),
            ip: Some("10.0.0.12".into()),
            url: Some("https://some-slug.example.com".into()),
            desktop_url: None,
            stop_after: Some("2026-08-23T12:00:00Z".into()),
            commands: Commands {
                ssh: "ori ssh ori_a1b2c3d4".into(),
                forward: "ori forward ori_a1b2c3d4 --remote 3000".into(),
            },
        };
        assert_eq!(
            ready.to_line().trim(),
            r#"{"event":"ready","id":"ori_a1b2c3d4","state":"ready","ip":"10.0.0.12","url":"https://some-slug.example.com","desktopUrl":null,"stopAfter":"2026-08-23T12:00:00Z","commands":{"ssh":"ori ssh ori_a1b2c3d4","forward":"ori forward ori_a1b2c3d4 --remote 3000"}}"#
        );

        let notice = StreamEvent::Notice {
            id: "ori_a1b2c3d4".into(),
            message: "forked from an older stopped snapshot".into(),
        };
        assert_eq!(
            notice.to_line().trim(),
            r#"{"event":"notice","id":"ori_a1b2c3d4","message":"forked from an older stopped snapshot"}"#
        );

        let err = StreamEvent::Error {
            id: "ori_a1b2c3d4".into(),
            code: "provider_unavailable".into(),
            message: "boom".into(),
        };
        assert_eq!(
            err.to_line().trim(),
            r#"{"event":"error","id":"ori_a1b2c3d4","code":"provider_unavailable","message":"boom"}"#
        );
    }

    #[test]
    fn filter_expansion() {
        assert_eq!(states_for_filter("r").unwrap(), vec!['r']);
        assert_eq!(
            states_for_filter("rspte").unwrap(),
            vec!['r', 's', 'p', 't', 'e']
        );
        assert!(states_for_filter("x").is_err());
        assert!(states_for_filter("").is_err());
    }
}
