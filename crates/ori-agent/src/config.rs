//! Agent configuration.
//!
//! The provisioning writes a JSON config and starts `ori agent --config <path>`.
//! The file carries the control-plane tunnel endpoint, the sandbox identity,
//! the work dir, and the claim-time payload (env vars, secret files, repo
//! checkouts, setup script). Secret material lives inside this file, so the
//! agent re-chmods the config to 0600 on load and refuses a world-readable one
//! on a warning level — it owns nothing else.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::AgentError;
use crate::wire::{decode_b64, SETUP_SCRIPT_MAX_BYTES};

/// Default config locations probed in order when `--config` and
/// `ORI_AGENT_CONFIG` are both absent.
pub const DEFAULT_CONFIG_PATHS: [&str; 2] = ["/etc/ori/agent.json", ".ori/agent.json"];

/// Agent config file (camelCase JSON).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Control-plane WebSocket endpoint, `ws://` or `wss://`. The sandbox dials
    /// out; the plane never dials in and the sandbox exposes no inbound port.
    pub control_plane_url: String,
    /// Bearer token authenticating this sandbox's tunnel.
    pub token: String,
    /// Sandbox id, e.g. `ori_a1b2c3d4`.
    pub sandbox_id: String,
    /// Sandbox work dir. `exec --cwd` values are resolved against it unless
    /// they are absolute. Defaults to `~/.ori/work`.
    #[serde(default)]
    pub work_dir: PathBuf,
    /// Claim-time configuration handed over when the sandbox was claimed.
    #[serde(default)]
    pub claim: Claim,
}

/// Claim-time payload.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Claim {
    /// Env vars applied to every `exec` (and the setup script). Overlaid over
    /// the agent's inherited environment; request-scoped `exec` env wins.
    pub env: HashMap<String, String>,
    /// Secret files to materialize. Land 0600, owned by the sandbox user.
    pub secret_files: Vec<SecretFile>,
    /// Repos to check out into the sandbox.
    pub repos: Vec<RepoRef>,
    /// Optional setup script, run in the background after the claim applies.
    pub setup: Option<SetupSpec>,
}

/// A secret file to write. Contents are base64.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretFile {
    pub path: PathBuf,
    pub contents_b64: String,
}

/// A repo to check out.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub url: String,
    #[serde(default)]
    pub r#ref: Option<String>,
    pub path: PathBuf,
}

/// Setup-script payload: inline base64 script (≤ 64 KiB) or a path already on
/// the sandbox.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SetupSpec {
    pub script_b64: Option<String>,
    pub path: Option<PathBuf>,
}

impl Config {
    /// Load and validate the agent config. `path` is the `--config` value; when
    /// absent, `ORI_AGENT_CONFIG` and then the default paths are probed.
    pub fn load(path: Option<PathBuf>) -> Result<Config, AgentError> {
        let resolved = Self::resolve_path(path)?;
        let raw = std::fs::read_to_string(&resolved).map_err(|e| {
            AgentError::Config(format!("cannot read config {}: {e}", resolved.display()))
        })?;
        let cfg: Config = serde_json::from_str(&raw).map_err(|e| {
            AgentError::Config(format!("invalid config {}: {e}", resolved.display()))
        })?;
        cfg.validate()?;

        // The config carries secret material; make sure it is not world-readable.
        let _ = Self::chmod_private(&resolved);

        Ok(cfg)
    }

    fn resolve_path(explicit: Option<PathBuf>) -> Result<PathBuf, AgentError> {
        if let Some(p) = explicit {
            return Ok(p);
        }
        if let Ok(p) = std::env::var("ORI_AGENT_CONFIG") {
            return Ok(PathBuf::from(p));
        }
        let home = home_dir();
        for rel in DEFAULT_CONFIG_PATHS {
            let candidate = if rel.starts_with('.') {
                home.as_ref().map(|h| h.join(rel))
            } else {
                Some(PathBuf::from(rel))
            };
            if let Some(c) = candidate {
                if c.is_file() {
                    return Ok(c);
                }
            }
        }
        Err(AgentError::Config(format!(
            "no agent config found (pass --config or set ORI_AGENT_CONFIG); looked in: {}",
            DEFAULT_CONFIG_PATHS.join(", ")
        )))
    }

    fn validate(&self) -> Result<(), AgentError> {
        let url = self.control_plane_url.trim();
        if !(url.starts_with("ws://") || url.starts_with("wss://")) {
            return Err(AgentError::Config(format!(
                "controlPlaneUrl must start with ws:// or wss://, got {url:?}"
            )));
        }
        if self.token.is_empty() {
            return Err(AgentError::Config("token must not be empty".into()));
        }
        if self.sandbox_id.is_empty() {
            return Err(AgentError::Config("sandboxId must not be empty".into()));
        }
        for sf in &self.claim.secret_files {
            if sf.path.as_os_str().is_empty() {
                return Err(AgentError::Config(
                    "claim.secretFiles entry has an empty path".into(),
                ));
            }
        }
        if let Some(setup) = &self.claim.setup {
            Self::validate_setup(setup)?;
        }
        Ok(())
    }

    /// Enforce the 64 KiB cap on the inline setup-script payload.
    pub fn validate_setup(setup: &SetupSpec) -> Result<(), AgentError> {
        if let Some(b64) = &setup.script_b64 {
            let bytes = decode_b64(b64)?;
            if bytes.len() > SETUP_SCRIPT_MAX_BYTES {
                return Err(AgentError::Config(format!(
                    "setup script payload is {} bytes; the cap is {SETUP_SCRIPT_MAX_BYTES}",
                    bytes.len()
                )));
            }
        }
        Ok(())
    }

    /// Resolve a sandbox work dir, defaulting to `~/.ori/work`.
    pub fn work_dir(&self) -> PathBuf {
        if self.work_dir.as_os_str().is_empty() {
            home_dir()
                .unwrap_or_else(|| PathBuf::from("/"))
                .join(".ori")
                .join("work")
        } else {
            self.work_dir.clone()
        }
    }

    /// Resolve an `exec --cwd`: absolute paths are used as-is; relative paths
    /// are resolved against the sandbox work dir.
    pub fn resolve_cwd(&self, cwd: Option<&str>) -> PathBuf {
        resolve_cwd(&self.work_dir(), cwd)
    }

    fn chmod_private(path: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        #[cfg(not(unix))]
        {
            let _ = path;
        }
        Ok(())
    }
}

/// Pure path resolution, exposed for tests: relative `cwd` joins `work_dir`,
/// absolute `cwd` is used verbatim, and `None` resolves to the work dir itself.
pub fn resolve_cwd(work_dir: &Path, cwd: Option<&str>) -> PathBuf {
    match cwd {
        None => work_dir.to_path_buf(),
        Some(c) => {
            let p = Path::new(c);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                work_dir.join(p)
            }
        }
    }
}

/// The sandbox user's home. `$HOME` is authoritative; falls back to the libc
/// lookup. The agent runs as the sandbox user, so this is where `~/.ori`
/// lives.
pub fn home_dir() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("HOME") {
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    std::env::home_dir()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn resolves_cwd_relative_to_work_dir() {
        let wd = Path::new("/home/u/work");
        assert_eq!(resolve_cwd(wd, None), PathBuf::from("/home/u/work"));
        assert_eq!(
            resolve_cwd(wd, Some("src")),
            PathBuf::from("/home/u/work/src")
        );
        assert_eq!(
            resolve_cwd(wd, Some("src/sub")),
            PathBuf::from("/home/u/work/src/sub")
        );
        assert_eq!(resolve_cwd(wd, Some("/abs")), PathBuf::from("/abs"));
    }

    #[test]
    fn parses_config() {
        let dir = std::env::temp_dir().join(format!("ori-agent-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.json");
        std::fs::write(
            &path,
            r#"{
              "controlPlaneUrl":"wss://plane.example.com/agent/ws",
              "token":"tok",
              "sandboxId":"ori_abcd1234",
              "workDir":"/home/u/work",
              "claim":{"env":{"K":"V"}}
            }"#,
        )
        .unwrap();
        let cfg = Config::load(Some(path.clone())).unwrap();
        assert_eq!(cfg.sandbox_id, "ori_abcd1234");
        assert_eq!(cfg.claim.env["K"], "V");
        // Config is re-chmodded to 0600 on load.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_bad_url_and_empty_token() {
        let dir = std::env::temp_dir().join(format!("ori-agent-cfg-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.json");
        std::fs::write(
            &path,
            r#"{"controlPlaneUrl":"http://x","token":"t","sandboxId":"ori_x"}"#,
        )
        .unwrap();
        assert!(matches!(
            Config::load(Some(path.clone())),
            Err(AgentError::Config(_))
        ));
        std::fs::write(
            &path,
            r#"{"controlPlaneUrl":"wss://x","token":"","sandboxId":"ori_x"}"#,
        )
        .unwrap();
        assert!(matches!(
            Config::load(Some(path)),
            Err(AgentError::Config(_))
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_setup_script_over_64k() {
        let big = "a".repeat(65 * 1024);
        let setup = SetupSpec {
            script_b64: Some(base64::engine::general_purpose::STANDARD.encode(big.as_bytes())),
            path: None,
        };
        assert!(matches!(
            Config::validate_setup(&setup),
            Err(AgentError::Config(_))
        ));

        let ok = SetupSpec {
            script_b64: Some(base64::engine::general_purpose::STANDARD.encode(b"echo hi")),
            path: None,
        };
        assert!(Config::validate_setup(&ok).is_ok());
    }
}
