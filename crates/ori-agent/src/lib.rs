//! `ori agent` — the guest agent that runs inside every sandbox.
//!
//! The sandbox opens an outbound WebSocket to the control plane (the plane
//! never dials in; the sandbox exposes no inbound port) and serves:
//!
//! - **`exec`** — run commands matching `ori exec` (`--cwd`, `--timeout`,
//!   streamed output, remote exit-code propagation), in ~1 s round trip
//!   instead of the 2.7 s the SSH fallback measures.
//! - **`--detach` / `--status <pid>`** — background jobs logged to
//!   `~/.ori/processes/<pid>.log`; unknown pids report `lost`, not error.
//! - **`host <port>`** — register a port with the plane and report whether
//!   anything is actually listening (and whether it is loopback-only — the
//!   most common `ori host` mistake).
//! - **Claim-time config injection** — env vars, secret files (0600, never via
//!   a world-readable temp path), and repo checkouts.
//! - **Setup script** — the ≤ 64 KiB `--setup-file` payload, run in the
//!   background after ready, with `setupStatus` (`pending|running|done|failed`)
//!   and `setupError` reported to the plane.
//!
//! Linux-only in production; `run` refuses to start elsewhere. The crate
//! compiles everywhere so `cargo test -p ori-agent` can run on a developer
//! machine, and the pure logic (protocol, backoff, procfs parsing, process
//! registry) is platform-independent and unit-tested.

mod backoff;
mod config;
mod error;
mod exec;
mod host;
mod inject;
mod processes;
mod procfs;
mod runtime;
mod setup;
mod tunnel;
mod wire;

pub use config::{Claim, Config, RepoRef, SecretFile, SetupSpec};
pub use error::AgentError;
pub use runtime::Agent;

/// Agent entrypoint. Blocks until the process is terminated.
///
/// Runs the agent loop on a dedicated thread with its own tokio runtime so it
/// works whether or not the caller is already inside a runtime (the CLI calls
/// this from an async context).
pub fn run(config: Option<std::path::PathBuf>) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = config;
        return Err(
            "ori agent runs inside Linux sandboxes and is not available on this platform".into(),
        );
    }

    #[cfg(target_os = "linux")]
    {
        let cfg = Config::load(config)?;
        let agent = std::sync::Arc::new(Agent::new(cfg.clone()));
        let cfg = std::sync::Arc::new(cfg);

        let handle = std::thread::Builder::new()
            .name("ori-agent".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .map_err(|e| AgentError::Config(format!("cannot build agent runtime: {e}")))?;
                rt.block_on(tunnel::run(cfg, agent))
            })?;

        match handle.join() {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err("ori agent thread panicked".into()),
        }
    }
}