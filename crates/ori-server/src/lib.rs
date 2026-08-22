//! ori-server: the control plane. `axum` + `tokio` + `sqlx` (SQLite, WAL).
//! Binary role is `ori serve`; this crate also ships a standalone
//! `ori-server` binary for development.

pub mod auth;
pub mod config;
pub mod db;
pub mod deletion;
pub mod error;
pub mod mock;
pub mod ndjson;
pub mod proto;
pub mod repo;
pub mod routes;
pub mod slug;
pub mod state;
pub mod tasks;
pub mod util;

use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::net::TcpListener;

use crate::config::Config;
use crate::mock::MockProvider;
use crate::proto::Provider;
use crate::state::AppState;

/// Build the route table over a caller-supplied database and provider.
/// Tests hand over an in-memory pool and a `MockProvider`.
pub fn build_app(db: SqlitePool, provider: Arc<dyn Provider>, config: Config) -> axum::Router {
    let state = AppState { db, provider, config: Arc::new(config) };
    routes::router(state)
}

/// Run the control plane to completion: migrate, reconcile once at startup,
/// resume interrupted deletion operations, then serve until the process is
/// signalled.
pub async fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let db = db::open(&config.database_path).await?;
    let provider: Arc<dyn Provider> = Arc::new(MockProvider::new());
    let state = AppState { db, provider, config: Arc::new(config.clone()) };

    // startup reconciliation: the provider is truth for existence
    if let Err(e) = tasks::reconcile_once(&state).await {
        tracing::warn!(error = %e, "startup reconciliation failed");
    }
    deletion::resume_pending_deletions(&state).await;

    let app = routes::router(state.clone());
    tasks::spawn_reaper(state.clone());
    tasks::spawn_reconciler(state.clone());

    let listener = TcpListener::bind(config.listen_addr).await?;
    tracing::info!(addr = %config.listen_addr, db = %config.database_path.display(), "ori control plane listening");
    axum::serve(listener, app).await?;
    Ok(())
}