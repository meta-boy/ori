//! Guest agent. Placeholder owned by C6 — this crate exists so the workspace
//! has a home for the agent, and so `ori agent` in the single binary has
//! something to call. The real agent (guest-side exec / port-host / file ops
//! over the control-plane tunnel) is C6's deliverable; this wiring keeps the
//! entrypoint from being a stub in the client crate.
//!
//! Deliberately dependency-light: the guest binary must not pull in
//! `ori-providers` (no Proxmox HTTP client inside a sandbox).

use std::path::PathBuf;

/// Agent entrypoint. Blocks until the agent is told to stop.
pub fn run(config: Option<PathBuf>) -> Result<(), Box<dyn std::error::Error>> {
    match config {
        Some(p) => println!("ori agent: guest agent starting with config {}", p.display()),
        None => println!("ori agent: guest agent starting (no config)"),
    }
    // C6: connect out to the control plane and serve exec/port-host/file ops.
    // Until then, exiting immediately is the honest behaviour — a silently
    // wedged agent loop would be worse than none.
    println!("ori agent: placeholder — the C6 guest agent has not landed yet; exiting");
    Ok(())
}