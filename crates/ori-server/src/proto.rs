//! Local stand-ins for types that belong in `ori-proto`.
//!
//! TODO(reconcile): `ori-proto` is being written in parallel and is currently
//! empty. Every type in this file duplicates a definition that will land there
//! (wire DTOs, NDJSON events, domain types, ID generation, the state machine,
//! and the `Provider` trait). When `ori-proto` lands, delete the local copy and
//! import from `ori-proto`; do not let the two drift. See `docs/DIVERGENCES.md`
//! in C11 for the reconciliation checklist.

use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/// ID with a fixed textual format. Generated with a CSPRNG (`getrandom`),
/// never a time-seeded PRNG.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TypedId {
    value: String,
}

impl TypedId {
    pub fn as_str(&self) -> &str {
        &self.value
    }
}

impl fmt::Display for TypedId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.value)
    }
}

impl FromStr for TypedId {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if s.is_empty() {
            return Err("empty id".into());
        }
        Ok(TypedId { value: s.to_string() })
    }
}

impl TypedId {
    /// Random id of `len` chars drawn uniformly from `alphabet`.
    pub fn random(len: usize, alphabet: &[char], prefix: &str) -> TypedId {
        let mut bytes = vec![0u8; len];
        // getrandom never fails on supported targets unless the platform
        // RNG is broken; treat failure as unreachable here.
        getrandom::fill(&mut bytes).expect("CSPRNG failure");
        let body: String = bytes
            .iter()
            .map(|b| alphabet[(*b as usize) % alphabet.len()])
            .collect();
        TypedId { value: format!("{prefix}{body}") }
    }

    /// `ori_` + 8 `[a-z0-9]` — sandbox id.
    pub fn sandbox() -> TypedId {
        TypedId::random(8, &BASE36, "ori_")
    }
    /// `oriop_` + 32 hex — async deletion operation id.
    pub fn deletion_op() -> TypedId {
        TypedId::random(32, &HEX, "oriop_")
    }
    /// `orik_` + 32 hex — api key id.
    pub fn api_key() -> TypedId {
        TypedId::random(32, &HEX, "orik_")
    }
    /// `orisnap_` + 32 hex — snapshot id.
    pub fn snapshot() -> TypedId {
        TypedId::random(32, &HEX, "orisnap_")
    }
    /// `orid_` + 32 hex — device-code login id.
    pub fn device_code() -> TypedId {
        TypedId::random(32, &HEX, "orid_")
    }
    /// `orip_` + 32 hex — process id.
    pub fn process() -> TypedId {
        TypedId::random(32, &HEX, "orip_")
    }
    /// `ori_sk_` + 40 hex — the api key secret shown exactly once.
    pub fn api_key_secret() -> TypedId {
        TypedId::random(40, &HEX, "ori_sk_")
    }
}

const BASE36: &[char] = &[
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i',
    'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
];

const HEX: &[char] = &[
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
];

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/// Every lifecycle state. Groups and transition table per `docs/SPEC-API.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoxState {
    Init,
    Provisioning,
    Provisioned,
    Cloning,
    Ready,
    Running,
    Idle,
    Stopping,
    Stopped,
    Archiving,
    Archived,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateGroup {
    Running,  // r
    Stopped,  // s
    Pending,  // p
    Stopping, // t
    Error,    // e
}

impl BoxState {
    pub fn group(&self) -> StateGroup {
        match self {
            BoxState::Cloning | BoxState::Ready | BoxState::Running | BoxState::Idle => {
                StateGroup::Running
            }
            BoxState::Stopped | BoxState::Archived => StateGroup::Stopped,
            BoxState::Init | BoxState::Provisioning | BoxState::Provisioned => StateGroup::Pending,
            BoxState::Stopping | BoxState::Archiving => StateGroup::Stopping,
            BoxState::Error => StateGroup::Error,
        }
    }

    pub fn letter(&self) -> char {
        match self.group() {
            StateGroup::Running => 'r',
            StateGroup::Stopped => 's',
            StateGroup::Pending => 'p',
            StateGroup::Stopping => 't',
            StateGroup::Error => 'e',
        }
    }

    /// Wire name, e.g. "ready".
    pub fn as_str(&self) -> &'static str {
        match self {
            BoxState::Init => "init",
            BoxState::Provisioning => "provisioning",
            BoxState::Provisioned => "provisioned",
            BoxState::Cloning => "cloning",
            BoxState::Ready => "ready",
            BoxState::Running => "running",
            BoxState::Idle => "idle",
            BoxState::Stopping => "stopping",
            BoxState::Stopped => "stopped",
            BoxState::Archiving => "archiving",
            BoxState::Archived => "archived",
            BoxState::Error => "error",
        }
    }

    /// Whether this state may move to `next`. A rejected transition is an
    /// error the server surfaces (409), never a silent no-op.
    pub fn can_transition_to(&self, next: BoxState) -> bool {
        use BoxState::*;
        match self {
            Init => matches!(next, Provisioning | Error),
            Provisioning => matches!(next, Provisioned | Cloning | Ready | Error),
            Provisioned => matches!(next, Cloning | Ready | Error),
            Cloning => matches!(next, Ready | Error),
            Ready | Running | Idle => matches!(next, Ready | Running | Idle | Stopping | Error),
            Stopping => matches!(next, Stopped | Error),
            Stopped => matches!(next, Provisioning | Error),
            Archiving => matches!(next, Archived | Error),
            Archived => matches!(next, Error),
            Error => matches!(next, Stopping | Provisioning | Error),
        }
    }
}

impl std::str::FromStr for BoxState {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "init" => Ok(BoxState::Init),
            "provisioning" => Ok(BoxState::Provisioning),
            "provisioned" => Ok(BoxState::Provisioned),
            "cloning" => Ok(BoxState::Cloning),
            "ready" => Ok(BoxState::Ready),
            "running" => Ok(BoxState::Running),
            "idle" => Ok(BoxState::Idle),
            "stopping" => Ok(BoxState::Stopping),
            "stopped" => Ok(BoxState::Stopped),
            "archiving" => Ok(BoxState::Archiving),
            "archived" => Ok(BoxState::Archived),
            "error" => Ok(BoxState::Error),
            other => Err(format!("unknown state: {other}")),
        }
    }
}

/// Expand a filter string like `rspte` (or default `r`) into state letters.
pub fn states_for_filter(filter: &str) -> Result<Vec<char>, String> {
    if filter.is_empty() {
        return Err("filter must not be empty".into());
    }
    let mut out = Vec::new();
    for c in filter.chars() {
        if !matches!(c, 'r' | 's' | 'p' | 't' | 'e') {
            return Err(format!("unknown filter letter: {c}"));
        }
        if !out.contains(&c) {
            out.push(c);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Machine types
// ---------------------------------------------------------------------------

/// One source of truth for vCPU / RAM / billing multiplier.
/// TODO(reconcile): belongs in `ori-proto`; the server must not restate these
/// numbers anywhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MachineType {
    Small,
    Default,
    Large,
}

impl MachineType {
    pub fn vcpu(&self) -> u32 {
        match self {
            MachineType::Small => 2,
            MachineType::Default => 4,
            MachineType::Large => 8,
        }
    }
    pub fn memory_gb(&self) -> u32 {
        match self {
            MachineType::Small => 4,
            MachineType::Default => 8,
            MachineType::Large => 16,
        }
    }
    pub fn billing_multiplier(&self) -> f64 {
        match self {
            MachineType::Small => 0.5,
            MachineType::Default => 1.0,
            MachineType::Large => 2.0,
        }
    }
}

// ---------------------------------------------------------------------------
// NDJSON event stream
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commands {
    pub ssh: String,
    pub forward: String,
}

/// One JSON object per line on the create / resume / fork streams.
/// Serialises to exactly the lines quoted in `docs/SPEC-API.md`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum StreamEvent {
    Created {
        id: String,
        ttl_seconds: Option<i64>,
        team: Option<String>,
    },
    State {
        id: String,
        state: String,
    },
    Accepted {
        id: String,
        status: String,
    },
    Ready {
        id: String,
        state: String,
        ip: Option<String>,
        url: Option<String>,
        desktop_url: Option<String>,
        stop_after: Option<String>,
        commands: Commands,
    },
    /// Terminal event on the stream. Once an error is known the HTTP status
    /// is long since sent, so errors ride the stream, not the status.
    Error {
        id: String,
        code: String,
        message: String,
    },
}

impl StreamEvent {
    /// Serialise to a single NDJSON line (trailing newline included).
    pub fn to_line(&self) -> String {
        let mut line = serde_json::to_string(self).expect("stream event serialisation");
        line.push('\n');
        line
    }
}

// ---------------------------------------------------------------------------
// Wire DTOs
// ---------------------------------------------------------------------------

/// The sandbox object from `docs/SPEC-API.md`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sandbox {
    pub id: String,
    pub name: String,
    pub state: BoxState,
    #[serde(rename = "type")]
    pub machine_type: MachineType,
    pub vcpu: u32,
    pub memory_gb: u32,
    pub billing_multiplier: f64,
    pub slug: String,
    pub url: Option<String>,
    pub ip: Option<String>,
    pub ssh_endpoint: Option<String>,
    pub desktop_available: bool,
    pub desktop_url: Option<String>,
    pub environment: String,
    pub environment_version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub stop_after: Option<String>,
    pub snapshot_available: bool,
    pub last_snapshot_attempt_at: Option<String>,
    pub last_snapshot_status: Option<String>,
    pub snapshot_completed_at: Option<String>,
    pub setup_status: Option<String>,
    pub setup_error: Option<String>,
    pub provider: String,
    pub team: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDetail {
    pub sandbox: Sandbox,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub has_more: bool,
    pub limit: u32,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxList {
    pub sandboxes: Vec<Sandbox>,
    pub page_info: PageInfo,
}

// -- create / resume / fork request bodies ----------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSandboxRequest {
    #[serde(rename = "type", alias = "machineType")]
    pub machine_type: Option<MachineType>,
    pub name: Option<String>,
    pub ttl_seconds: Option<i64>,
    pub no_auto_stop: Option<bool>,
    pub env: Option<HashMap<String, String>>,
    pub no_env: Option<bool>,
    pub environment: Option<String>,
    /// Create from an existing snapshot id (`ori new --from`).
    pub from: Option<String>,
    pub setup_file: Option<String>,
    pub team: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSandboxRequest {
    #[serde(rename = "type", alias = "machineType")]
    pub machine_type: Option<MachineType>,
    pub ttl_seconds: Option<i64>,
    pub no_auto_stop: Option<bool>,
    pub env: Option<HashMap<String, String>>,
    pub no_env: Option<bool>,
    pub environment: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkSandboxRequest {
    #[serde(rename = "type", alias = "machineType")]
    pub machine_type: Option<MachineType>,
    pub name: Option<String>,
    pub ttl_seconds: Option<i64>,
    pub no_auto_stop: Option<bool>,
    pub env: Option<HashMap<String, String>>,
    pub no_env: Option<bool>,
    pub environment: Option<String>,
    pub team: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopSandboxRequest {
    /// `ori stop --force` — skip the snapshot, data-lossy.
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtendSandboxRequest {
    pub hours: Option<i64>,
    pub ttl_seconds: Option<i64>,
    pub no_auto_stop: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequestBody {
    pub cmd: Vec<String>,
    pub cwd: Option<String>,
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub detach: bool,
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResponse {
    pub pid: i64,
    pub completed: bool,
    pub exit_code: i64,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: i64,
}

// -- async deletion operations ----------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub sandbox_id: String,
    pub status: String,
    pub blocked_reason: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationDetail {
    pub operation: Operation,
}

// -- api keys ----------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApiKeyRequest {
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKey {
    pub id: String,
    pub name: Option<String>,
    pub prefix: String,
    pub last_four: String,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

/// The secret is present exactly once, on creation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyCreated {
    pub id: String,
    pub name: Option<String>,
    pub prefix: String,
    pub last_four: String,
    pub secret: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyList {
    pub api_keys: Vec<ApiKey>,
}

// -- account / limits / teams ------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub identifier: String,
    pub login_state: String,
    pub plan: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub plan: String,
    pub max_running_sandboxes: i64,
    pub max_total_sandboxes: i64,
    pub max_storage_gb: i64,
    pub current_running: i64,
    pub current_total: i64,
    pub rate_limit_per_minute: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    pub scope: String,
    pub role: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamList {
    pub teams: Vec<Team>,
}

// -- device-code login -------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartRequest {
    pub client_name: Option<String>,
    pub client_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartResponse {
    pub id: String,
    pub code: String,
    pub url: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPollResponse {
    /// pending | approved | expired
    pub status: String,
    /// Present only once the code is approved.
    pub token: Option<String>,
    pub account: Option<Account>,
}

// -- misc --------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliVersion {
    pub current: String,
    pub latest: String,
    pub channel: String,
    pub update_available: bool,
}

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

#[derive(Debug, Clone)]
pub struct InstanceSpec {
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

    async fn create(&self, spec: &InstanceSpec) -> Result<InstanceHandle, ProviderError>;
    async fn clone_from(&self, src: &SnapshotRef, spec: &InstanceSpec)
        -> Result<InstanceHandle, ProviderError>;
    async fn start(&self, h: &InstanceHandle) -> Result<(), ProviderError>;
    async fn stop(&self, h: &InstanceHandle, mode: StopMode) -> Result<(), ProviderError>;
    async fn destroy(&self, h: &InstanceHandle) -> Result<(), ProviderError>;
    async fn status(&self, h: &InstanceHandle) -> Result<InstanceStatus, ProviderError>;

    async fn snapshot(&self, h: &InstanceHandle, name: &str) -> Result<SnapshotRef, ProviderError>;
    async fn rollback(&self, h: &InstanceHandle, s: &SnapshotRef) -> Result<(), ProviderError>;
    async fn snapshot_delete(&self, s: &SnapshotRef) -> Result<(), ProviderError>;

    async fn exec(&self, h: &InstanceHandle, req: &ExecRequest) -> Result<ExecResult, ProviderError>;
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
        assert!(id.as_str()[4..].chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));

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
        assert_eq!(serde_json::to_string(&MachineType::Small).unwrap(), "\"small\"");
        assert_eq!(serde_json::to_string(&BoxState::Ready).unwrap(), "\"ready\"");
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

        let state = StreamEvent::State { id: "ori_a1b2c3d4".into(), state: "cloning".into() };
        assert_eq!(state.to_line().trim(), r#"{"event":"state","id":"ori_a1b2c3d4","state":"cloning"}"#);

        let accepted = StreamEvent::Accepted { id: "ori_a1b2c3d4".into(), status: "resuming".into() };
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
        assert_eq!(states_for_filter("rspte").unwrap(), vec!['r', 's', 'p', 't', 'e']);
        assert!(states_for_filter("x").is_err());
        assert!(states_for_filter("").is_err());
    }
}