//! Server configuration. All values overridable via environment variables.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

/// Which sandbox backend the control plane drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Mock,
    Proxmox,
    Docker,
}

impl Default for ProviderKind {
    fn default() -> Self {
        ProviderKind::Mock
    }
}

impl FromStr for ProviderKind {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "mock" => Ok(ProviderKind::Mock),
            "proxmox" => Ok(ProviderKind::Proxmox),
            "docker" => Ok(ProviderKind::Docker),
            other => Err(format!("unknown provider {other:?}; expected mock|proxmox|docker")),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub database_path: PathBuf,
    /// Hostname used to mint `<slug>.<domain>` URLs.
    pub domain: String,
    /// Sandbox backend. `ORI_PROVIDER` env.
    pub provider: ProviderKind,
    /// How often the TTL reaper wakes.
    pub reap_interval: Duration,
    /// How often the provider reconciliation loop wakes.
    pub reconcile_interval: Duration,
    /// Default auto-stop deadline for new sandboxes, in seconds.
    pub default_ttl_seconds: i64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            listen_addr: "127.0.0.1:8080".parse().unwrap(),
            database_path: PathBuf::from("./ori.db"),
            domain: "ori.localhost".to_string(),
            provider: ProviderKind::Mock,
            reap_interval: Duration::from_secs(10),
            reconcile_interval: Duration::from_secs(30),
            default_ttl_seconds: 900,
        }
    }
}

impl Config {
    pub fn from_env() -> Config {
        let mut cfg = Config::default();
        if let Ok(v) = std::env::var("ORI_LISTEN") {
            if let Ok(addr) = v.parse() {
                cfg.listen_addr = addr;
            }
        }
        if let Ok(v) = std::env::var("ORI_DB_PATH") {
            cfg.database_path = PathBuf::from(v);
        }
        if let Ok(v) = std::env::var("ORI_DOMAIN") {
            cfg.domain = v;
        }
        if let Ok(v) = std::env::var("ORI_PROVIDER") {
            if let Ok(k) = v.parse() {
                cfg.provider = k;
            }
        }
        if let Ok(v) = std::env::var("ORI_REAP_INTERVAL_SECS") {
            if let Ok(n) = v.parse::<u64>() {
                cfg.reap_interval = Duration::from_secs(n);
            }
        }
        if let Ok(v) = std::env::var("ORI_RECONCILE_INTERVAL_SECS") {
            if let Ok(n) = v.parse::<u64>() {
                cfg.reconcile_interval = Duration::from_secs(n);
            }
        }
        if let Ok(v) = std::env::var("ORI_DEFAULT_TTL_SECS") {
            if let Ok(n) = v.parse::<i64>() {
                cfg.default_ttl_seconds = n;
            }
        }
        cfg
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let cfg = Config::default();
        assert_eq!(cfg.listen_addr.port(), 8080);
        assert_eq!(cfg.default_ttl_seconds, 900);
        assert_eq!(cfg.domain, "ori.localhost");
        assert_eq!(cfg.provider, ProviderKind::Mock);
    }

    #[test]
    fn provider_kinds_parse() {
        assert_eq!("mock".parse::<ProviderKind>().unwrap(), ProviderKind::Mock);
        assert_eq!("proxmox".parse::<ProviderKind>().unwrap(), ProviderKind::Proxmox);
        assert_eq!("docker".parse::<ProviderKind>().unwrap(), ProviderKind::Docker);
        assert!("firecracker".parse::<ProviderKind>().is_err());
    }
}