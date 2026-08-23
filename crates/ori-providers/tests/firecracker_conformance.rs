//! Generic capability conformance suite against a real Firecracker host,
//! behind env. Ignored by default:
//! `cargo test -p ori-providers --features firecracker -- --ignored`.
//!
//! Reads `ORI_FC_*` (from the ambient environment or `.env.local` at the repo
//! root). Requires a Linux host with KVM, the jailer + firecracker binaries,
//! a kernel (`ORI_FC_KERNEL`) and a rootfs (`ORI_FC_ROOTFS`) whose init runs
//! the bootstrap exec shim (see `firecracker::exec::EXEC_SHIM_RS`) — that is
//! what makes the base lifecycle's `exec` and the `live_suspend` marker
//! round-trip work.

#![cfg(feature = "firecracker")]

mod common;
mod conformance;

use std::sync::Arc;

use ori_providers::firecracker::FirecrackerProvider;
use ori_providers::reconcile::{InstanceSpec, MachineType};

#[tokio::test]
#[ignore = "requires a real jailer + firecracker + KVM host (ORI_FC_* env)"]
async fn firecracker_passes_declared_capabilities() {
    common::load_env();
    let config = ori_providers::firecracker::FirecrackerConfig::from_env()
        .expect("firecracker config from env");
    let provider = FirecrackerProvider::new(config);

    let make_spec = move |name: &str| InstanceSpec {
        id: name.to_string(),
        // Firecracker ignores vmid.
        vmid: 1,
        name: name.to_string(),
        machine_type: MachineType::Small,
        // Empty template: the configured rootfs is used.
        template: String::new(),
        storage: String::new(),
        environment: None,
        environment_version: None,
    };

    let suite = conformance::Conformance::new(Arc::new(provider), make_spec);
    let failures = suite.run().await;
    assert!(
        failures.is_empty(),
        "firecracker failed its own capability conformance:\n{}",
        failures.join("\n")
    );
}
