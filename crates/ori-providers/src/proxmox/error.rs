use std::time::Duration;

use reqwest::StatusCode;

/// Low-level errors from the Proxmox REST API. The `Provider` impl maps these
/// onto `crate::reconcile::Error` at the trait boundary.
#[derive(Debug, thiserror::Error)]
pub enum PveError {
    #[error("http {status} from {path}: {body}")]
    Http {
        status: StatusCode,
        path: String,
        body: String,
    },
    #[error("unexpected response from {path}: {body}")]
    UnexpectedResponse { path: String, body: String },
    #[error("request to {path} failed: {source}")]
    Transport {
        path: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("task {upid} failed: {reason}")]
    TaskFailed { upid: String, reason: String },
    #[error("task {upid} did not finish within {timeout:?}")]
    TaskTimeout { upid: String, timeout: Duration },
    #[error("instance {handle} did not reach state {want:?} within {timeout:?}")]
    StateTimeout {
        handle: String,
        want: String,
        timeout: Duration,
    },
    #[error("node {node} not found in the cluster")]
    NodeMissing { node: String },
    #[error("node {node} is not online (status {status:?})")]
    NodeNotOnline { node: String, status: String },
    #[error("storage {storage} cannot snapshot (type {kind:?}); use LVM-thin or ZFS, not dir")]
    StorageNotSnapshotCapable { storage: String, kind: String },
    #[error("storage {storage} not found on node {node}")]
    StorageMissing { node: String, storage: String },
    #[error("template {template} not found on node {node} storage {storage}")]
    TemplateMissing {
        node: String,
        storage: String,
        template: String,
    },
    #[error("vmid {vmid} is already in use (next free is {nextid}); caller must allocate from its own counter")]
    VmidCollision { vmid: u32, nextid: u32 },
    #[error("vmid {vmid} out of range (100..=999_999_999)")]
    VmidOutOfRange { vmid: u32 },
    #[error("snapshot ref {id} not on this provider's node (expected {node})")]
    SnapshotNodeMismatch { id: String, node: String },
    #[error("malformed handle {0:?}: expected node/vmid")]
    MalformedHandle(String),
    #[error("malformed snapshot ref {0:?}: expected node/vmid/name")]
    MalformedSnapshotRef(String),
    #[error("wrong provider {0:?}: expected proxmox")]
    WrongProvider(String),
    #[error("exec: {0}")]
    Exec(String),
    #[error("invalid config: {0}")]
    Config(String),
    #[error("invalid data: {0}")]
    Data(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl PveError {
    /// Map a raw HTTP response into the closest `PveError`.
    pub fn from_http(status: StatusCode, path: &str, body: String) -> Self {
        let truncated = if body.len() > 512 {
            format!("{}…", &body[..512])
        } else {
            body
        };
        PveError::Http {
            status,
            path: path.to_string(),
            body: truncated,
        }
    }
}
