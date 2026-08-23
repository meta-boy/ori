//! Configuration for the Apple container backend.
//!
//! `serde`-deserializable so the server can construct it from JSON config,
//! plus [`AppleContainerConfig::from_env`] for the integration/conformance
//! tests (`ORI_APPLE_CONTAINER_*`), mirroring `docker::DockerConfig`.

use crate::reconcile::Error;

fn default_bin() -> String {
    "container".to_string()
}

fn default_image() -> String {
    "alpine:latest".to_string()
}

fn default_keep_alive() -> bool {
    true
}

fn default_exec_timeout_secs() -> u64 {
    60
}

fn default_state_timeout_secs() -> u64 {
    60
}

/// Configuration for the Apple container provider.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AppleContainerConfig {
    /// Path to the `container` CLI. Default `container` (on PATH).
    #[serde(default = "default_bin")]
    pub bin: String,
    /// Image cold creates are made from, e.g. `alpine:latest`.
    #[serde(default = "default_image")]
    pub image: String,
    /// Keep the sandbox running with `sleep infinity` when the image's CMD
    /// would exit immediately (alpine's `/bin/sh` does). On by default.
    #[serde(default = "default_keep_alive")]
    pub keep_alive: bool,
    /// Network containers attach to (macOS 26+; macOS 15 has a single default
    /// network and no user-defined ones).
    #[serde(default)]
    pub network: Option<String>,
    /// Default `exec` timeout in seconds (default 60).
    #[serde(default = "default_exec_timeout_secs")]
    pub exec_timeout_secs: u64,
    /// How long `status` polls for a container to reach a state (default 60 s).
    #[serde(default = "default_state_timeout_secs")]
    pub state_timeout_secs: u64,
}

impl AppleContainerConfig {
    /// Build from `ORI_APPLE_CONTAINER_*` environment variables
    /// (integration/conformance tests).
    pub fn from_env() -> Result<Self, Error> {
        fn truthy(v: Result<String, std::env::VarError>) -> bool {
            matches!(v.as_deref(), Ok("1") | Ok("true") | Ok("yes"))
        }
        Ok(AppleContainerConfig {
            bin: std::env::var("ORI_APPLE_CONTAINER_BIN").unwrap_or_else(|_| default_bin()),
            image: std::env::var("ORI_APPLE_CONTAINER_IMAGE").unwrap_or_else(|_| default_image()),
            keep_alive: {
                let v = std::env::var("ORI_APPLE_CONTAINER_KEEP_ALIVE").ok();
                v.map(|s| truthy(Ok(s))).unwrap_or(true)
            },
            network: std::env::var("ORI_APPLE_CONTAINER_NETWORK").ok(),
            exec_timeout_secs: std::env::var("ORI_APPLE_CONTAINER_EXEC_TIMEOUT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_exec_timeout_secs),
            state_timeout_secs: std::env::var("ORI_APPLE_CONTAINER_STATE_TIMEOUT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(default_state_timeout_secs),
        })
    }
}
