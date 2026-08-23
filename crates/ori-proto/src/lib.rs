//! The wire contract, defined once.
//!
//! Both the control plane and the client speak these types. They used to be
//! defined twice - ~990 lines in `ori-server` and ~510 in `ori-cli` - and the
//! copies drifted: the server emitted `memoryGb` where the client required
//! `memoryGB`, and `ori list` broke outright. Both sides round-tripped their
//! own copy perfectly, so no test on either side could catch it.
//!
//! Defining them here makes that class of bug unrepresentable rather than
//! merely tested-for. This crate stays I/O-free and dependency-light on
//! purpose: `ori-agent` links it too, and has no use for a database driver or
//! an HTTP client.

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
        Ok(TypedId {
            value: s.to_string(),
        })
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
        TypedId {
            value: format!("{prefix}{body}"),
        }
    }

    /// `ori_` + 8 `[a-z0-9]` — sandbox id.
    pub fn sandbox() -> TypedId {
        TypedId::random(8, BASE36, "ori_")
    }
    /// `oriop_` + 32 hex — async deletion operation id.
    pub fn deletion_op() -> TypedId {
        TypedId::random(32, HEX, "oriop_")
    }
    /// `orik_` + 32 hex — api key id.
    pub fn api_key() -> TypedId {
        TypedId::random(32, HEX, "orik_")
    }
    /// `orisnap_` + 32 hex — snapshot id.
    pub fn snapshot() -> TypedId {
        TypedId::random(32, HEX, "orisnap_")
    }
    /// `orid_` + 32 hex — device-code login id.
    pub fn device_code() -> TypedId {
        TypedId::random(32, HEX, "orid_")
    }
    /// `orip_` + 32 hex — process id.
    pub fn process() -> TypedId {
        TypedId::random(32, HEX, "orip_")
    }
    /// `orie_` + 16 hex — environment id.
    pub fn env() -> TypedId {
        TypedId::random(16, HEX, "orie_")
    }
    /// `oriev_` + 16 hex — environment version id.
    pub fn env_version() -> TypedId {
        TypedId::random(16, HEX, "oriev_")
    }
    /// `orievar_` + 16 hex — environment var id.
    pub fn env_var() -> TypedId {
        TypedId::random(16, HEX, "orievar_")
    }
    /// `orief_` + 16 hex — environment file id.
    pub fn env_file() -> TypedId {
        TypedId::random(16, HEX, "orief_")
    }
    /// `orier_` + 16 hex — environment repo id.
    pub fn env_repo() -> TypedId {
        TypedId::random(16, HEX, "orier_")
    }
    /// `ori_sk_` + 40 hex — the api key secret shown exactly once.
    pub fn api_key_secret() -> TypedId {
        TypedId::random(40, HEX, "ori_sk_")
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
    /// Every state, in a stable order.
    pub const ALL: [BoxState; 12] = [
        BoxState::Init,
        BoxState::Provisioning,
        BoxState::Provisioned,
        BoxState::Cloning,
        BoxState::Ready,
        BoxState::Running,
        BoxState::Idle,
        BoxState::Stopping,
        BoxState::Stopped,
        BoxState::Archiving,
        BoxState::Archived,
        BoxState::Error,
    ];

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
    pub fn as_str(&self) -> &'static str {
        match self {
            MachineType::Small => "small",
            MachineType::Default => "default",
            MachineType::Large => "large",
        }
    }
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

impl std::str::FromStr for MachineType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "small" => Ok(MachineType::Small),
            "default" => Ok(MachineType::Default),
            "large" => Ok(MachineType::Large),
            other => Err(format!("unknown machine type: {other}")),
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
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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
    /// Non-terminal informational line, e.g. a fork that reused an older
    /// stopped-taken snapshot and therefore omits writes made since it. The
    /// CLI renders it as progress; it never ends the stream.
    Notice {
        id: String,
        message: String,
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
    #[serde(rename = "memoryGB")]
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

/// `POST /sandboxes/{id}/extend` response. The new deadline is stated at the
/// top level as well as on the sandbox: a caller must be able to see exactly
/// what `extend` produced without re-reading `sandbox.stopAfter`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtendResponse {
    pub sandbox: Sandbox,
    /// The new auto-stop deadline (`null` = auto-stop disabled).
    pub stop_after: Option<String>,
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
    /// `type` per spec; `ty` is what the current CLI sends; `machineType` is
    /// accepted for symmetry with the resume/fork request shapes.
    #[serde(rename = "type", alias = "machineType", alias = "ty")]
    pub machine_type: Option<MachineType>,
    pub name: Option<String>,
    pub ttl_seconds: Option<i64>,
    pub no_auto_stop: Option<bool>,
    pub env: Option<HashMap<String, String>>,
    pub no_env: Option<bool>,
    /// Setup script contents. The CLI calls this `setupScript`.
    #[serde(rename = "setupScript", alias = "setupFile")]
    pub setup_script: Option<String>,
    pub environment: Option<String>,
    /// Create from an existing snapshot id (`ori new --from`). CLI: `fromSnapshot`.
    #[serde(rename = "fromSnapshot", alias = "from")]
    pub from_snapshot: Option<String>,
    pub team: Option<String>,
    /// v1: single personal scope; accepted and ignored.
    pub personal: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSandboxRequest {
    #[serde(rename = "type", alias = "machineType", alias = "ty")]
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
    #[serde(rename = "type", alias = "machineType", alias = "ty")]
    pub machine_type: Option<MachineType>,
    pub name: Option<String>,
    pub ttl_seconds: Option<i64>,
    pub no_auto_stop: Option<bool>,
    pub env: Option<HashMap<String, String>>,
    pub no_env: Option<bool>,
    pub environment: Option<String>,
    pub team: Option<String>,
    /// `ori fork --no-stop`: when the source is running with no stopped
    /// snapshot, refuse instead of stopping, snapshotting and restarting it.
    pub no_stop: Option<bool>,
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
    /// `cmd` per spec; `command` is what the CLI sends.
    #[serde(alias = "command")]
    pub cmd: Vec<String>,
    pub cwd: Option<String>,
    /// `timeoutSecs` per spec; `timeout` is what the CLI sends.
    #[serde(rename = "timeout", alias = "timeoutSecs")]
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

/// `POST /api-keys/{id}/rotate` response: a fresh key (secret shown once) plus
/// whether the rotated key was the one that authenticated the request — when
/// true, the caller's stored token is now dead and must be replaced with the
/// returned secret.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyRotated {
    pub api_key: ApiKeyCreated,
    pub current: bool,
}

// -- account ----------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub identifier: String,
    pub login_state: String,
    pub status: String,
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
    /// `provider` / `email` are what the CLI sends; ignored in this build.
    pub provider: Option<String>,
    pub email: Option<String>,
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
