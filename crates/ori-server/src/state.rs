//! Shared application state passed to every handler.

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::config::Config;
use crate::pool::PoolManager;
use crate::proto::Provider;
use crate::tunnel::AgentRegistry;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub provider: Arc<dyn Provider>,
    pub config: Arc<Config>,
    /// Warm pool. `None` when disabled (`--pool-depth 0`, the default), so
    /// `ori new` always cold-creates.
    pub pool: Option<PoolManager>,
    /// Live agent tunnels, keyed by sandbox id. Empty until agents connect;
    /// `exec` falls back to the provider for any sandbox not in here.
    pub agents: AgentRegistry,
}
