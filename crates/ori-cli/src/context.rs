//! Per-invocation context: resolved config, api url, token, http client.

use std::path::PathBuf;

use crate::api::Api;
use crate::cli::Cli;
use crate::config::{config_path, Config, DEFAULT_API_URL};
use crate::error::CliError;

pub struct Ctx {
    pub json: bool,
    pub no_update: bool,
    pub config: Config,
    pub config_path: Option<PathBuf>,
    /// The user-facing API url (before the `/api/v1` suffix is applied).
    pub api_url_raw: String,
    pub api: Api,
}

impl Ctx {
    pub fn load(cli: &Cli, json: bool) -> Result<Self, CliError> {
        let config_path = config_path();
        let config = Config::load(config_path.as_deref())?;
        let api_url_raw = cli
            .api_url
            .clone()
            .or_else(|| config.api_url.clone())
            .unwrap_or_else(|| DEFAULT_API_URL.to_string());
        let api = Api::new(&api_url_raw, config.token.clone());
        Ok(Self {
            json,
            no_update: cli.no_update,
            config,
            config_path,
            api_url_raw,
            api,
        })
    }

    pub fn save_config(&self) -> Result<(), CliError> {
        self.config.save(self.config_path.as_deref())
    }
}
