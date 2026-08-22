//! Generic capability conformance suite against a real Proxmox host, behind
//! env. Ignored by default:
//! `cargo test -p ori-providers -- --ignored`.
//!
//! Reads `ORI_PVE_*` (from the ambient environment or `.env.local` at the repo
//! root). Requires `ORI_PVE_SSH` too, because the base lifecycle exec test uses
//! the provider's bootstrap-only exec fallback. Free vmids are drawn from the
//! `ORI_PVE_TEST_VMID_MIN`..=`ORI_PVE_TEST_VMID_MAX` range like
//! `proxmox_lifecycle.rs`.

#![cfg(feature = "proxmox")]

mod common;
mod conformance;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use ori_providers::proxmox::ProxmoxProvider;
use ori_providers::reconcile::{InstanceSpec, MachineType};

#[tokio::test]
#[ignore = "requires a real Proxmox host (ORI_PVE_* env)"]
async fn proxmox_passes_declared_capabilities() {
    common::load_env();
    let config =
        ori_providers::proxmox::ProxmoxConfig::from_env().expect("proxmox config from env");
    let provider = ProxmoxProvider::new(config.clone())
        .await
        .expect("preflight against the real host");

    // Allocate the conformance instances' vmids up front from the reserved test
    // range, exactly like the lifecycle test does.
    let min: u32 = common::env("ORI_PVE_TEST_VMID_MIN")
        .parse()
        .expect("vmid min");
    let max: u32 = common::env("ORI_PVE_TEST_VMID_MAX")
        .parse()
        .expect("vmid max");
    let in_use = provider
        .client()
        .lxc_vmids()
        .await
        .expect("list existing vmids");
    let free: Vec<u32> = (min..=max).filter(|v| !in_use.contains(v)).collect();
    assert!(
        free.len() >= 8,
        "conformance needs ~8 free vmids in {min}..={max}, have {}",
        free.len()
    );

    let counter = Arc::new(AtomicUsize::new(0));
    let pconf = provider.config().clone();
    let template = pconf.template.clone();
    let storage = pconf.storage.clone();
    let make_spec = move |name: &str| {
        let vmid = free[counter.fetch_add(1, Ordering::SeqCst) % free.len()];
        InstanceSpec {
            id: name.to_string(),
            vmid,
            name: name.to_string(),
            machine_type: MachineType::Small,
            template: template.clone(),
            storage: storage.clone(),
            environment: None,
            environment_version: None,
        }
    };

    let suite = conformance::Conformance::new(Arc::new(provider), make_spec);
    let failures = suite.run().await;
    assert!(
        failures.is_empty(),
        "proxmox failed its own capability conformance:\n{}",
        failures.join("\n")
    );
}
