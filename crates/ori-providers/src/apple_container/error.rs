//! Low-level errors from the `container` CLI. The `Provider` impl maps these
//! onto `crate::reconcile::Error` at the trait boundary.

/// Low-level errors from the Apple container backend.
#[derive(Debug, thiserror::Error)]
pub enum AppleError {
    /// The `container` binary could not be spawned.
    #[error("cannot run container cli ({bin}): {message}")]
    Cli { bin: String, message: String },
    /// The CLI ran but exited non-zero.
    #[error("container {args} exited {exit}: {stderr}")]
    CliFailed {
        args: String,
        exit: i32,
        stderr: String,
    },
    #[error("malformed handle {0:?}")]
    MalformedHandle(String),
    #[error("wrong provider {0:?}: expected apple-container")]
    WrongProvider(String),
    #[error("container not found: {0}")]
    NotFound(String),
    #[error("invalid config: {0}")]
    Config(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("apple container: {0}")]
    Other(String),
}
