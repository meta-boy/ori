//! Low-level errors from the Docker Engine API. The `Provider` impl maps these
//! onto `crate::reconcile::Error` at the trait boundary, mirroring how
//! `proxmox::error::PveError` feeds `ProxmoxProvider::map_err`.

/// Low-level errors from the Docker Engine API.
#[derive(Debug, thiserror::Error)]
pub enum DockerError {
    /// A docker Engine HTTP error. `304 Not Modified` is docker's success reply
    /// for `start`/`stop` on an already started/stopped container.
    #[error("docker responded with HTTP {status}: {message}")]
    Http { status: u16, message: String },
    #[error("docker request failed: {0}")]
    Transport(String),
    #[error("docker socket not found: {0}")]
    SocketNotFound(String),
    #[error("docker stream error: {0}")]
    Stream(String),
    #[error("malformed handle {0:?}")]
    MalformedHandle(String),
    #[error("malformed snapshot ref {0:?}")]
    MalformedSnapshotRef(String),
    #[error("wrong provider {0:?}: expected docker")]
    WrongProvider(String),
    #[error("invalid config: {0}")]
    Config(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("docker: {0}")]
    Other(String),
}

impl DockerError {
    /// Map a raw bollard error into the closest `DockerError`.
    pub fn from_bollard(e: bollard::errors::Error) -> Self {
        use bollard::errors::Error as B;
        match e {
            B::DockerResponseServerError {
                status_code,
                message,
            } => DockerError::Http {
                status: status_code,
                message,
            },
            B::DockerStreamError { error } => DockerError::Stream(error),
            B::SocketNotFoundError(path) => DockerError::SocketNotFound(path),
            B::RequestTimeoutError => DockerError::Transport("request timed out".to_string()),
            B::IOError { err } => DockerError::Io(err),
            other => DockerError::Other(other.to_string()),
        }
    }

    /// The docker HTTP status code, if this is an HTTP error.
    pub fn status(&self) -> Option<u16> {
        match self {
            DockerError::Http { status, .. } => Some(*status),
            _ => None,
        }
    }
}
