//! Shell-out helpers for the `container` CLI: run commands, parse
//! `container list --format json`, and build `ExecResult`s from `container
//! exec`.

use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::reconcile::{Addresses, ExecRequest, ExecResult, InstanceStatus};

use super::config::AppleContainerConfig;
use super::error::AppleError;

/// The parsed shape of `container list --format json` and `container inspect`
/// (both emit a top-level array of ManagedContainer with camelCase keys).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedContainer {
    id: String,
    status: ContainerStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContainerStatus {
    state: String,
    #[serde(default)]
    networks: Vec<NetworkAttachment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkAttachment {
    #[serde(default)]
    ipv4_address: Option<String>,
}

/// Run the CLI and require exit 0; stderr becomes the error message.
pub async fn run_ok(config: &AppleContainerConfig, args: Vec<String>) -> Result<(), AppleError> {
    let (exit, _stdout, stderr) = run(config, args.clone()).await?;
    if exit == 0 {
        Ok(())
    } else {
        Err(AppleError::CliFailed {
            args: args.join(" "),
            exit,
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }
}

/// Run the CLI, returning `(exit code, stdout, stderr)`.
pub async fn run(
    config: &AppleContainerConfig,
    args: Vec<String>,
) -> Result<(i32, Vec<u8>, Vec<u8>), AppleError> {
    let output = tokio::process::Command::new(&config.bin)
        .args(&args)
        .output()
        .await
        .map_err(|e| AppleError::Cli {
            bin: config.bin.clone(),
            message: e.to_string(),
        })?;
    Ok((
        output.status.code().unwrap_or(-1),
        output.stdout,
        output.stderr,
    ))
}

/// The provider's view of a container's state. A container missing from the
/// list is `Unknown`; `stopping` is treated as alive (like docker's
/// RESTARTING/PAUSED).
pub async fn instance_status(
    config: &AppleContainerConfig,
    id: &str,
) -> Result<InstanceStatus, AppleError> {
    Ok(match find_container(config, id).await? {
        Some(c) => match c.status.state.as_str() {
            "running" | "stopping" => InstanceStatus::Running,
            _ => InstanceStatus::Stopped,
        },
        None => InstanceStatus::Unknown,
    })
}

/// Best-effort addresses from the container's network attachments.
pub async fn instance_addresses(
    config: &AppleContainerConfig,
    id: &str,
) -> Result<Addresses, AppleError> {
    let mut v4: Vec<std::net::IpAddr> = Vec::new();
    let mut v6: Vec<std::net::IpAddr> = Vec::new();
    if let Some(c) = find_container(config, id).await? {
        for attach in c.status.networks {
            let Some(ip) = attach.ipv4_address else {
                continue;
            };
            let Ok(addr) = ip.parse::<std::net::IpAddr>() else {
                continue;
            };
            if addr.is_loopback() {
                continue;
            }
            match addr {
                std::net::IpAddr::V4(_) if !v4.contains(&addr) => v4.push(addr),
                std::net::IpAddr::V6(_) if !v6.contains(&addr) => v6.push(addr),
                _ => {}
            }
        }
    }
    Ok(Addresses {
        v4,
        v6,
        hostname: None,
    })
}

/// Run `container exec` in the guest and collect its output. The CLI forwards
/// the executed process's exit code.
pub async fn exec(
    config: &AppleContainerConfig,
    id: &str,
    req: ExecRequest,
    timeout: Duration,
) -> Result<ExecResult, AppleError> {
    let mut args = vec!["exec".to_string()];
    for (k, v) in &req.env {
        args.push("--env".to_string());
        args.push(format!("{k}={v}"));
    }
    if let Some(w) = &req.workdir {
        args.push("--workdir".to_string());
        args.push(w.clone());
    }
    args.push(id.to_string());
    args.extend(req.command);

    let started = Instant::now();
    let output = tokio::time::timeout(
        timeout,
        tokio::process::Command::new(&config.bin)
            .args(&args)
            .output(),
    )
    .await
    .map_err(|_| AppleError::Other("exec timed out".to_string()))?
    .map_err(|e| AppleError::Cli {
        bin: config.bin.clone(),
        message: e.to_string(),
    })?;
    Ok(ExecResult {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: output.stdout,
        stderr: output.stderr,
        duration: started.elapsed(),
    })
}

async fn find_container(
    config: &AppleContainerConfig,
    id: &str,
) -> Result<Option<ManagedContainer>, AppleError> {
    let (exit, stdout, stderr) = run(
        config,
        vec![
            "list".to_string(),
            "--all".to_string(),
            "--format".to_string(),
            "json".to_string(),
        ],
    )
    .await?;
    if exit != 0 {
        return Err(AppleError::CliFailed {
            args: "list --all --format json".to_string(),
            exit,
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        });
    }
    let containers: Vec<ManagedContainer> = serde_json::from_slice(&stdout).map_err(|e| {
        AppleError::Other(format!("cannot parse `container list --format json`: {e}"))
    })?;
    Ok(containers.into_iter().find(|c| c.id == id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_list_json_with_camel_case_keys() {
        let json = r#"[
            {"id":"ori-a","configuration":{"id":"ori-a"},"status":{"state":"running","networks":[{"ipv4Address":"192.168.64.3"}],"startedDate":null}},
            {"id":"ori-b","configuration":{"id":"ori-b"},"status":{"state":"stopped","networks":[],"startedDate":null}}
        ]"#;
        let containers: Vec<ManagedContainer> = serde_json::from_str(json).unwrap();
        assert_eq!(containers.len(), 2);
        assert_eq!(containers[0].id, "ori-a");
        assert_eq!(containers[0].status.state, "running");
        assert_eq!(
            containers[0].status.networks[0].ipv4_address.as_deref(),
            Some("192.168.64.3")
        );
        assert_eq!(containers[1].status.state, "stopped");
        assert!(containers[1].status.networks.is_empty());
    }

    #[test]
    fn status_mapping_covers_runtime_status_enum() {
        // The CLI's RuntimeStatus: unknown, stopped, running, stopping.
        fn state(s: &str) -> InstanceStatus {
            match s {
                "running" | "stopping" => InstanceStatus::Running,
                _ => InstanceStatus::Stopped,
            }
        }
        assert_eq!(state("running"), InstanceStatus::Running);
        assert_eq!(state("stopping"), InstanceStatus::Running);
        assert_eq!(state("stopped"), InstanceStatus::Stopped);
        assert_eq!(state("unknown"), InstanceStatus::Stopped);
    }
}
