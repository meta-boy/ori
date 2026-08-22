//! Integration test against the real Proxmox host in `.env.local`.
//!
//! Ignored by default: `cargo test -p ori-providers -- --ignored --nocapture`.
//! Env comes from `.env.local` at the repo root (`ORI_PVE_*`); the file is
//! gitignored and not committed.
//!
//! Runs the real lifecycle from the plan, asserting each step stays inside the
//! `docs/BENCHMARKS.md` budget:
//! create → snapshot → linked clone → start → exec → stop → start → destroy.
//!
//! Every created container is destroyed on success and on failure — a leaked
//! container on a real backend costs money.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use ori_providers::proxmox::ProxmoxProvider;
use ori_providers::reconcile::{
    ExecRequest, InstanceHandle, InstanceSpec, MachineType, Provider, StopMode,
};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// Multiply all budgets. Defaults to 1.0 (the strict `docs/BENCHMARKS.md`
/// numbers). Set `ORI_PVE_BUDGET_SCALE` > 1 when running against a shared host
/// that other agents are actively snapshotting/cloning/rolling back — the
/// documented "poisoned thin-pool" condition makes a linked clone of a running
/// source take ~44 s instead of ~2 s. CI runs the strict default.
fn budget_scale() -> f32 {
    std::env::var("ORI_PVE_BUDGET_SCALE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1.0)
        .max(1.0)
}

/// Load `ORI_PVE_*` from `.env.local` (repo root) into the environment, unless
/// already set.
fn load_env() {
    let path = repo_root().join(".env.local");
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            panic!("cannot read {path:?}: {e}; integration tests need the real host")
        }
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let k = k.trim().trim_start_matches("export ");
        let v = v.trim().trim_matches('"').trim_matches('\'');
        if !k.starts_with("ORI_PVE_") {
            continue;
        }
        if std::env::var(k).is_err() {
            // SAFETY: single-threaded test setup; edition 2021.
            unsafe {
                std::env::set_var(k, v);
            }
        }
    }
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing env {name}"))
}

/// Find two free VMIDs inside the reserved test range.
async fn pick_vmids(provider: &ProxmoxProvider, count: usize) -> Vec<u32> {
    let min: u32 = env("ORI_PVE_TEST_VMID_MIN").parse().expect("vmid min");
    let max: u32 = env("ORI_PVE_TEST_VMID_MAX").parse().expect("vmid max");
    let in_use = provider
        .client()
        .lxc_vmids()
        .await
        .expect("list existing vmids");
    let mut free: Vec<u32> = (min..=max).filter(|v| !in_use.contains(v)).collect();
    assert!(free.len() >= count, "test vmid range {min}..={max} exhausted");
    free.truncate(count);
    free
}

fn spec(vmid: u32, name: &str) -> InstanceSpec {
    InstanceSpec {
        id: format!("ori_it_{vmid}"),
        vmid,
        name: name.to_string(),
        machine_type: MachineType::Default,
        template: env("ORI_PVE_TEMPLATE_ALPINE"),
        storage: env("ORI_PVE_STORAGE"),
        environment: None,
        environment_version: None,
    }
}

fn assert_budget(label: &str, elapsed: Duration, budget: Duration) -> Result<(), String> {
    let budget = Duration::from_secs_f32(budget.as_secs_f32() * budget_scale());
    if elapsed <= budget {
        println!("{label}: {elapsed:?}");
        Ok(())
    } else {
        Err(format!(
            "{label} took {elapsed:?}, budget was {budget:?} (docs/BENCHMARKS.md)"
        ))
    }
}

#[tokio::test]
#[ignore]
async fn real_lifecycle_stays_within_benchmark_budgets() {
    load_env();

    let config = ori_providers::proxmox::ProxmoxConfig::from_env().expect("config from env");
    let provider = ProxmoxProvider::new(config)
        .await
        .expect("preflight against the real host");

    let vmids = pick_vmids(&provider, 2).await;
    let src_vmid = vmids[0];
    let clone_vmid = vmids[1];

    let mut created: Vec<InstanceHandle> = Vec::new();
    let outcome: Result<(), String> = async {
        // create — cold create total (Alpine) measured 6.4 s; target ≤ 7 s.
        let t = Instant::now();
        let src = provider
            .create(&spec(src_vmid, "ori-it-src"))
            .await
            .map_err(|e| format!("create: {e}"))?;
        created.push(src.clone());
        assert_budget("create", t.elapsed(), Duration::from_secs(9))?;

        // snapshot — measured 1.15 s.
        let t = Instant::now();
        let snap = provider
            .snapshot(&src, "golden")
            .await
            .map_err(|e| format!("snapshot: {e}"))?;
        assert_budget("snapshot", t.elapsed(), Duration::from_secs(5))?;

        // linked clone — measured 1.65–1.83 s (O(1) in disk size).
        let t = Instant::now();
        let child = provider
            .clone_from(&snap, &spec(clone_vmid, "ori-it-child"))
            .await
            .map_err(|e| format!("clone_from: {e}"))?;
        created.push(child.clone());
        assert_budget("clone_from", t.elapsed(), Duration::from_secs(6))?;

        // start — measured 3.0 s to running, 4.4 s to exec-ready.
        let t = Instant::now();
        provider
            .start(&child)
            .await
            .map_err(|e| format!("start: {e}"))?;
        assert_budget("start", t.elapsed(), Duration::from_secs(8))?;

        // exec — pct exec round trip measured 0.90 s (bootstrap fallback).
        let t = Instant::now();
        let exec = provider
            .exec(
                &child,
                ExecRequest {
                    command: vec!["echo".to_string(), "ori-exec-ok".to_string()],
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

        // stop — snapshot + power off measured 3.37 s.
        let t = Instant::now();
        provider
            .stop(&child, StopMode::Snapshot)
            .await
            .map_err(|e| format!("stop: {e}"))?;
        assert_budget("stop", t.elapsed(), Duration::from_secs(6))?;

        // start again (resume) — measured 4.4 s to exec-ready.
        let t = Instant::now();
        provider
            .start(&child)
            .await
            .map_err(|e| format!("resume: {e}"))?;
        assert_budget("resume", t.elapsed(), Duration::from_secs(8))?;

        // addresses must come back after the resumed start.
        let addrs = provider
            .addresses(&child)
            .await
            .map_err(|e| format!("addresses: {e}"))?;
        assert!(
            !addrs.v4.is_empty(),
            "resumed instance should have an IPv4 address, got {addrs:?}"
        );

        Ok(())
    }
    .await;

    // Cleanup, success or failure. destroy is idempotent.
    for h in &created {
        let _ = provider.destroy(h).await;
    }

    if let Err(e) = outcome {
        panic!("lifecycle failed: {e}");
    }
    println!("lifecycle OK; vmids {src_vmid} {clone_vmid} cleaned up");
}