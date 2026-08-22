//! `ori agent` — the guest-agent role of the single binary. Runs inside each
//! sandbox and is Linux-only, per `docs/ARCHITECTURE.md`.

use crate::cli::AgentArgs;
use crate::error::CliError;

#[cfg(target_os = "linux")]
pub async fn agent(args: AgentArgs) -> Result<(), CliError> {
    ori_agent::run(args.config)
        .map_err(|e| CliError::usage(format!("agent: {e}")))
}

#[cfg(not(target_os = "linux"))]
pub async fn agent(_args: AgentArgs) -> Result<(), CliError> {
    Err(CliError::usage(
        "ori agent runs inside Linux sandboxes and is not available on this platform",
    ))
}