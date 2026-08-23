//! Low-level errors from the Firecracker control API and the jailer. The
//! `Provider` impl maps these onto `crate::reconcile::Error` at the trait
//! boundary, mirroring how `docker::error::DockerError` feeds
//! `DockerProvider::map_err`.

/// Low-level errors from the Firecracker backend.
#[derive(Debug, thiserror::Error)]
pub enum FcError {
    /// The Firecracker control API returned a non-2xx status.
    #[error("firecracker responded with HTTP {status}: {message}")]
    Http { status: u16, message: String },
    /// A request to the control socket failed at the transport level.
    #[error("firecracker request failed: {0}")]
    Transport(String),
    /// The jailer failed to come up for an instance.
    #[error("jailer for {id} exited {status}: {stderr}")]
    JailerFailed {
        id: String,
        status: String,
        stderr: String,
    },
    /// The response body was not the JSON we expected.
    #[error("unexpected response from firecracker: {0}")]
    Data(String),
    #[error("malformed handle {0:?}")]
    MalformedHandle(String),
    #[error("wrong provider {0:?}: expected firecracker")]
    WrongProvider(String),
    #[error("invalid config: {0}")]
    Config(String),
    #[error("instance {0} is not running")]
    NotRunning(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("firecracker: {0}")]
    Other(String),
}

impl FcError {
    /// The HTTP status code, if this is an HTTP error.
    pub fn status(&self) -> Option<u16> {
        match self {
            FcError::Http { status, .. } => Some(*status),
            _ => None,
        }
    }
}
