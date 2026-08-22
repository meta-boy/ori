//! Stub handlers for commands not shipped in this build. They parse their full
//! clap surface (help matches the spec) and then fail with a clear error.

use crate::error::CliError;

pub fn unimplemented(command: &'static str) -> CliError {
    CliError::Unimplemented { command }
}
