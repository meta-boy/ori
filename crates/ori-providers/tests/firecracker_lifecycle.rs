//! Integration test against a real Firecracker host, mirroring
//! `proxmox_lifecycle.rs`. Ignored by default:
//! `cargo test -p ori-providers --features firecracker -- --ignored`.
//!
//! Reads `ORI_FC_*` from `.env.local` or the ambient environment. Requires
//! KVM, the jailer + firecracker binaries, a kernel, and a rootfs whose init
//! runs the bootstrap exec shim (see `firecracker::exec::EXEC_SHIM_RS`).
//!
//! Runs the lifecycle this backend exists for: create → write a guest marker →
//! **suspend** (`stop Snapshot` = snapshot-create) → **resume** (`start` =
//! snapshot-load) → read the marker back. The marker surviving the round-trip
//! is the proof that resume restored memory instead of power-cycling. Every
//! created instance is destroyed on success and on failure.

#![cfg(feature = "firecracker")]

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use ori_providers::firecracker::FirecrackerProvider;
use ori_providers::reconcile::{
    ExecRequest, InstanceHandle, InstanceSpec, InstanceStatus, MachineType, Provider, StopMode,
};

fn spec(name: &str) -> InstanceSpec {
    InstanceSpec {
        id: name.to_string(),
        vmid: 1,
        name: name.to_string(),
        machine_type: MachineType::Small,
        template: String::new(),
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

async fn exec_ok(
    provider: &Arc<FirecrackerProvider>,
    h: &InstanceHandle,
    command: Vec<String>,
) -> Result<String, String> {
    let res = provider
        .exec(
            h,
            ExecRequest {
                command,
                timeout: Some(Duration::from_secs(30)),
                env: vec![],
                workdir: None,
            },
        )
        .await
        .map_err(|e| format!("exec: {e}"))?;
    let stdout = String::from_utf8_lossy(&res.stdout).into_owned();
    if res.exit_code != 0 {
        return Err(format!(
            "exec exit {}\nstdout: {stdout}\nstderr: {}",
            res.exit_code,
            String::from_utf8_lossy(&res.stderr)
        ));
    }
    Ok(stdout)
}

#[tokio::test]
#[ignore = "requires a real jailer + firecracker + KVM host (ORI_FC_* env)"]
async fn real_suspend_resume_round_trips_guest_state() {
    common::load_env();
    let config =
        ori_providers::firecracker::FirecrackerConfig::from_env().expect("firecracker config");
    let provider = Arc::new(FirecrackerProvider::new(config));

    let name = format!("ori-fc-lc-{}", std::process::id());
    let marker = "ori-fc-suspend-marker";
    let mut created: Vec<InstanceHandle> = Vec::new();
    let outcome: Result<(), String> = async {
        // create — jail, materialize kernel+rootfs, boot.
        let t = Instant::now();
        let h = provider
            .create(&spec(&name))
            .await
            .map_err(|e| format!("create: {e}"))?;
        created.push(h.clone());
        assert_budget("create", t.elapsed(), Duration::from_secs(60))?;

        // Write a marker into guest memory.
        let out = exec_ok(
            &provider,
            &h,
            vec![
                "sh".to_string(),
                "-c".to_string(),
                format!("echo {marker} > /tmp/ori-fc-marker"),
            ],
        )
        .await?;
        if !out.contains(marker) {
            return Err(format!("marker write failed: {out:?}"));
        }

        // suspend — live suspend is snapshot-create, the whole point.
        let t = Instant::now();
        provider
            .stop(&h, StopMode::Snapshot)
            .await
            .map_err(|e| format!("suspend (stop Snapshot): {e}"))?;
        assert_budget("suspend", t.elapsed(), Duration::from_secs(30))?;
        let st = provider
            .status(&h)
            .await
            .map_err(|e| format!("status: {e}"))?;
        if st != InstanceStatus::Stopped {
            return Err(format!("expected Stopped after suspend, got {st:?}"));
        }

        // resume — snapshot-load, not a power cycle.
        let t = Instant::now();
        provider
            .start(&h)
            .await
            .map_err(|e| format!("resume (start): {e}"))?;
        assert_budget("resume", t.elapsed(), Duration::from_secs(15))?;
        let st = provider
            .status(&h)
            .await
            .map_err(|e| format!("status: {e}"))?;
        if st != InstanceStatus::Running {
            return Err(format!("expected Running after resume, got {st:?}"));
        }

        // The marker must survive — proof that memory was restored.
        let out = exec_ok(
            &provider,
            &h,
            vec![
                "sh".to_string(),
                "-c".to_string(),
                "cat /tmp/ori-fc-marker".to_string(),
            ],
        )
        .await?;
        if !out.contains(marker) {
            return Err(format!(
                "marker lost across suspend/resume; read back: {out:?}"
            ));
        }
        println!("marker survived suspend/resume");

        // Cold boot path: stop Force, then start boots fresh (no marker).
        provider
            .stop(&h, StopMode::Force)
            .await
            .map_err(|e| format!("stop Force: {e}"))?;
        let t = Instant::now();
        provider
            .start(&h)
            .await
            .map_err(|e| format!("cold start: {e}"))?;
        assert_budget("cold start", t.elapsed(), Duration::from_secs(60))?;

        Ok(())
    }
    .await;

    for h in &created {
        let _ = provider.destroy(h).await;
    }

    if let Err(e) = outcome {
        panic!("firecracker lifecycle failed: {e}");
    }
    println!("firecracker lifecycle OK; {name} cleaned up");
}
