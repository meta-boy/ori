//! Error taxonomy and exit-code mapping.
//!
//! Exit codes (per `docs/SPEC-CLI.md`): 0 success, 1 local/usage error,
//! 2 API error, and the *remote* command's code for `exec`/`ssh`.

use std::fmt;

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.status == 0 {
            write!(f, "{}: {}", self.code, self.message)
        } else {
            write!(f, "HTTP {} {}: {}", self.status, self.code, self.message)
        }
    }
}

impl std::error::Error for ApiError {}

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    /// Local/usage error — exit 1.
    #[error("{0}")]
    Usage(String),
    /// Server/API error — exit 2.
    #[error("{0}")]
    Api(ApiError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Serde(#[from] serde_json::Error),
    /// A command we knowingly do not ship in this build — exit 1.
    #[error("{command} is not implemented in this build")]
    Unimplemented { command: &'static str },
    /// `exec` finished; carry the remote exit code. Never printed.
    #[error("")]
    RemoteExit(i32),
}

impl CliError {
    pub fn usage(msg: impl Into<String>) -> Self {
        CliError::Usage(msg.into())
    }
}

/// Map an error to the process exit code.
pub fn exit_code(e: &CliError) -> i32 {
    match e {
        CliError::RemoteExit(code) => *code,
        CliError::Api(_) => 2,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_code_mapping() {
        assert_eq!(exit_code(&CliError::Usage("x".into())), 1);
        assert_eq!(
            exit_code(&CliError::Api(ApiError { status: 500, code: "boom".into(), message: "m".into() })),
            2
        );
        assert_eq!(exit_code(&CliError::Unimplemented { command: "serve" }), 1);
        assert_eq!(exit_code(&CliError::RemoteExit(0)), 0);
        assert_eq!(exit_code(&CliError::RemoteExit(42)), 42);
        assert_eq!(exit_code(&CliError::RemoteExit(2)), 2);
    }
}