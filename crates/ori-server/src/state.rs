//! Shared application state passed to every handler.

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::config::Config;
use crate::proto::Provider;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub provider: Arc<dyn Provider>,
    pub config: Arc<Config>,
}
