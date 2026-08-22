//! Client-side config file.
//!
//! `~/.config/ori/config.json` (Linux) or `~/Library/Application Support/ori/config.json`
//! (macOS), holding token / api url / channel, mode 0600. Resolved via the
//! `directories` crate, never hand-rolled platform paths.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::CliError;

/// TODO(reconcile): placeholder production endpoint. `ori-proto`/`ori-server`
/// will pin the real value; `--api-url` and `ORI_API_URL` always win over this.
pub const DEFAULT_API_URL: &str = "https://api.ori.dev";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub token: Option<String>,
    pub api_url: Option<String>,
    pub channel: String,
}

impl Default for Config {
    fn default() -> Self {
        Self { token: None, api_url: None, channel: "stable".to_string() }
    }
}

impl Config {
    pub fn load(path: Option<&Path>) -> Result<Self, CliError> {
        match path {
            Some(p) if p.exists() => {
                let raw = fs::read_to_string(p).map_err(|e| {
                    CliError::usage(format!("cannot read config {}: {e}", p.display()))
                })?;
                serde_json::from_str(&raw).map_err(|e| {
                    CliError::usage(format!("config {} is not valid JSON: {e}", p.display()))
                })
            }
            _ => Ok(Config::default()),
        }
    }

    pub fn save(&self, path: Option<&Path>) -> Result<(), CliError> {
        let Some(path) = path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                CliError::usage(format!("cannot create config dir {}: {e}", parent.display()))
            })?;
        }
        let json = serde_json::to_string_pretty(self)?;
        fs::write(path, json).map_err(|e| {
            CliError::usage(format!("cannot write config {}: {e}", path.display()))
        })?;
        set_private_mode(path)?;
        Ok(())
    }
}

/// The OS-appropriate config file path (may not exist yet).
pub fn config_path() -> Option<PathBuf> {
    directories::ProjectDirs::from("", "", "ori").map(|d| d.config_dir().join("config.json"))
}

#[cfg(unix)]
fn set_private_mode(path: &Path) -> Result<(), CliError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| {
        CliError::usage(format!("cannot chmod config {}: {e}", path.display()))
    })
}

#[cfg(not(unix))]
fn set_private_mode(_path: &Path) -> Result<(), CliError> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn config_saved_with_mode_0600() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.json");
        let cfg = Config { token: Some("tok".into()), api_url: None, channel: "stable".into() };
        cfg.save(Some(&path)).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "config file must be 0600, got {mode:o}");

        let loaded = Config::load(Some(&path)).unwrap();
        assert_eq!(loaded.token.as_deref(), Some("tok"));
        assert_eq!(loaded.channel, "stable");
    }

    #[test]
    fn missing_config_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(Some(&dir.path().join("does-not-exist.json"))).unwrap();
        assert_eq!(cfg.token, None);
        assert_eq!(cfg.channel, "stable");
    }
}