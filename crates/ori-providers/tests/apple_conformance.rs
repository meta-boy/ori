//! Generic capability conformance suite against the real `container` CLI
//! (macOS 26, Apple silicon), behind env. Ignored by default:
//! `cargo test -p ori-providers --features apple-container -- --ignored`.
//!
//! Reads `ORI_APPLE_CONTAINER_*` (from the ambient environment or
//! `.env.local` at the repo root). Runs the base lifecycle against a real
//! `container` install; no snapshot capability is declared (absent documented
//! support), so only the base trait contract is exercised.

#![cfg(feature = "apple-container")]

mod common;
mod conformance;

use std::sync::Arc;

use ori_providers::apple_container::AppleContainerProvider;
use ori_providers::reconcile::{InstanceSpec, MachineType};

fn apple_spec(image: String) -> impl Fn(&str) -> InstanceSpec {
    move |name: &str| InstanceSpec {
        id: name.to_string(),
        // apple container ignores vmid.
        vmid: 1,
        name: name.to_string(),
        machine_type: MachineType::Small,
        template: image.clone(),
        storage: String::new(),
        environment: None,
        environment_version: None,
    }
}

#[tokio::test]
#[ignore = "requires the apple `container` CLI on macOS 26 (ORI_APPLE_CONTAINER_* env)"]
async fn apple_container_passes_base_lifecycle() {
    common::load_env();
    let config = ori_providers::apple_container::AppleContainerConfig::from_env()
        .expect("apple container config from env");
    let image = config.image.clone();
    let provider = AppleContainerProvider::new(config);

    let suite = conformance::Conformance::new(Arc::new(provider), apple_spec(image));
    let failures = suite.run().await;
    assert!(
        failures.is_empty(),
        "apple-container failed base conformance:\n{}",
        failures.join("\n")
    );
}
