//! Integration test against the real Docker socket, mirroring
//! `proxmox_lifecycle.rs`. Ignored by default:
//! `cargo test -p ori-providers --features docker -- --ignored`.
//!
//! Runs the real lifecycle: create → snapshot → linked clone → start → exec →
//! stop → start → destroy, asserting each step stays inside a generous budget.
//! Every created container is destroyed on success and on failure — a leaked
//! container on a real daemon costs money.

#![cfg(feature = "docker")]

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use ori_providers::docker::DockerProvider;
use ori_providers::reconcile::{
    ExecRequest, InstanceHandle, InstanceSpec, MachineType, Provider, StopMode,
};

fn spec(name: &str, image: String) -> InstanceSpec {
    InstanceSpec {
        id: name.to_string(),
        vmid: 1,
        name: name.to_string(),
        machine_type: MachineType::Default,
        template: image,
        storage: String::new(),
        environment: None,
        environment_version: None,
    }
}

fn assert_budget(label: &str, elapsed: Duration, budget: Duration) -> Result<(), String> {
    if elapsed <= budget {
        println!("{label}: {elapsed:?}");
        Ok(())
    } else {
        Err(format!("{label} took {elapsed:?}, budget was {budget:?}"))
    }
}

#[tokio::test]
#[ignore = "requires a real Docker socket"]
async fn real_lifecycle() {
    common::load_env();
    let config = ori_providers::docker::DockerConfig::from_env().expect("docker config from env");
    let image = config.image.clone();
    let snapshot_repo = config.snapshot_repo.clone();
    let provider = Arc::new(DockerProvider::new(config).expect("connect to the docker daemon"));
    provider.preflight().await.expect("daemon preflight");

    let src_name = format!("ori-it-src-{}", std::process::id());
    let child_name = format!("ori-it-child-{}", std::process::id());

    let mut created: Vec<InstanceHandle> = Vec::new();
    let outcome: Result<(), String> = async {
        // create (cold, from image) — docker is fast once the image is pulled.
        let t = Instant::now();
        let src = provider
            .create(&spec(&src_name, image.clone()))
            .await
            .map_err(|e| format!("create: {e}"))?;
        created.push(src.clone());
        assert_budget("create", t.elapsed(), Duration::from_secs(30))?;

        // snapshot — commit to an image tag.
        let t = Instant::now();
        let snap = provider
            .snapshot(&src, "golden")
            .await
            .map_err(|e| format!("snapshot: {e}"))?;
        assert_budget("snapshot", t.elapsed(), Duration::from_secs(10))?;

        // linked clone — container from the committed image.
        let t = Instant::now();
        let child = Provider::clone_from(
            provider.as_ref(),
            &snap,
            &spec(&child_name, image),
        )
        .await
        .map_err(|e| format!("clone_from: {e}"))?;
        created.push(child.clone());
        assert_budget("clone_from", t.elapsed(), Duration::from_secs(5))?;

        // start the clone.
        let t = Instant::now();
        provider
            .start(&child)
            .await
            .map_err(|e| format!("start: {e}"))?;
        assert_budget("start", t.elapsed(), Duration::from_secs(5))?;

        // exec.
        let t = Instant::now();
        let exec = provider
            .exec(
                &child,
                ExecRequest {
                    command: vec!["echo".into(), "ori-exec-ok".into()],
                    timeout: Some(Duration::from_secs(30)),
                    env: vec![],
                    workdir: None,
                },
            )
            .await
            .map_err(|e| format!("exec: {e}"))?;
        assert_budget("exec", t.elapsed(), Duration::from_secs(5))?;
        assert_eq!(
            String::from_utf8_lossy(&exec.stdout).trim(),
            "ori-exec-ok",
            "exec must reach the container"
        );
        assert_eq!(exec.exit_code, 0, "exec must succeed");

        // stop (snapshot first, then power off).
        let t = Instant::now();
        provider
            .stop(&child, StopMode::Snapshot)
            .await
            .map_err(|e| format!("stop: {e}"))?;
        assert_budget("stop", t.elapsed(), Duration::from_secs(10))?;

        // resume.
        let t = Instant::now();
        provider
            .start(&child)
            .await
            .map_err(|e| format!("resume: {e}"))?;
        assert_budget("resume", t.elapsed(), Duration::from_secs(5))?;

        // addresses must come back after the resumed start.
        let addrs = provider
            .addresses(&child)
            .await
            .map_err(|e| format!("addresses: {e}"))?;
        assert!(
            !addrs.v4.is_empty() || !addrs.v6.is_empty(),
            "resumed instance should have an address, got {addrs:?}"
        );

        Ok(())
    }
    .await;

    // Cleanup, success or failure. destroy is idempotent.
    for h in &created {
        let _ = provider.destroy(h).await;
    }
    // Drop the golden image used by this run.
    let _ = provider
        .snapshot_delete(&ori_providers::reconcile::SnapshotRef {
            provider: "docker".to_string(),
            id: format!("{snapshot_repo}:golden"),
            name: "golden".to_string(),
        })
        .await;

    if let Err(e) = outcome {
        panic!("lifecycle failed: {e}");
    }
    println!("lifecycle OK; containers {src_name} {child_name} cleaned up");
}