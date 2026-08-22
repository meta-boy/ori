//! Generic capability conformance suite against a real Docker socket.
//!
//! Ignored by default: `cargo test -p ori-providers --features docker -- --ignored`.
//! Configure with `ORI_DOCKER_*` env (or `.env.local` at the repo root); the
//! default is the local docker daemon and `alpine:latest`.

#![cfg(feature = "docker")]

mod common;
mod conformance;

use std::sync::Arc;

use ori_providers::docker::DockerProvider;
use ori_providers::reconcile::{InstanceSpec, MachineType};

fn docker_spec(image: String) -> impl Fn(&str) -> InstanceSpec {
    move |name: &str| InstanceSpec {
        id: name.to_string(),
        // docker ignores vmid.
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
#[ignore = "requires a real Docker socket"]
async fn docker_passes_declared_capabilities() {
    common::load_env();
    let config = ori_providers::docker::DockerConfig::from_env().expect("docker config from env");
    let image = config.image.clone();
    let provider = DockerProvider::new(config).expect("connect to the docker daemon");
    provider.preflight().await.expect("daemon preflight");

    let suite = conformance::Conformance::new(Arc::new(provider), docker_spec(image));
    let failures = suite.run().await;
    assert!(
        failures.is_empty(),
        "docker failed its own capability conformance:\n{}",
        failures.join("\n")
    );
}