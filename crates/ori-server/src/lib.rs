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
pub mod pool;
pub mod proto;
pub mod providers;
pub mod repo;
pub mod routes;
pub mod slug;
pub mod state;
pub mod tasks;
pub mod tunnel;
pub mod util;

use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::net::TcpListener;

use crate::config::Config;
use crate::pool::{PoolConfig, PoolManager};
use crate::proto::Provider;
use crate::state::AppState;

/// Build the warm pool for a server run, or `None` when disabled
/// (`pool_depth == 0`, the default). The pool shares the db and provider with
/// the request path; refill and reconciliation run off it, never on a request.
fn pool_for(db: SqlitePool, provider: Arc<dyn Provider>, config: &Config) -> Option<PoolManager> {
    if config.pool_depth == 0 {
        return None;
    }
    Some(PoolManager::new(
        db,
        provider,
        PoolConfig {
            depth: config.pool_depth,
            ..PoolConfig::default()
        },
    ))
}

/// Build the route table over a caller-supplied database and provider.
/// Tests hand over an in-memory pool and a `MockProvider`.
pub fn build_app(db: SqlitePool, provider: Arc<dyn Provider>, config: Config) -> axum::Router {
    let pool = pool_for(db.clone(), provider.clone(), &config);
    let state = AppState {
        db,
        provider,
        config: Arc::new(config),
        pool,
        agents: crate::tunnel::AgentRegistry::new(),
    };
    routes::router(state)
}

/// Run the control plane to completion: migrate, build the configured
/// provider (running its startup preflight), reconcile once at startup,
/// resume interrupted deletion operations, then serve until the process is
/// signalled. With `--pool-depth > 0`, the pool is reconciled at startup,
/// refilled in the background, and drained on shutdown.
pub async fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let db = db::open(&config.database_path).await?;
    let provider = providers::build_provider(&config, db.clone()).await?;
    let pool = pool_for(db.clone(), provider.clone(), &config);
    let state = AppState {
        db,
        provider,
        config: Arc::new(config.clone()),
        pool,
        agents: crate::tunnel::AgentRegistry::new(),
    };

    // Register the configured golden snapshot before the pool does anything.
    // Without this the golden_snapshots table stays empty, refill has nothing
    // to clone, and the pool silently never fills.
    if let Some(pool) = &state.pool {
        match &config.pool_golden {
            Some(golden) => {
                let snap = proto::SnapshotRef {
                    provider: state.provider.name().to_string(),
                    name: golden.clone(),
                };
                for mt in [
                    proto::MachineType::Small,
                    proto::MachineType::Default,
                    proto::MachineType::Large,
                ] {
                    let key = pool::PoolKey {
                        provider: state.provider.name().to_string(),
                        machine_type: mt,
                        environment_version: 1,
                    };
                    if let Err(e) = pool.register_golden(&key, "base", &snap).await {
                        tracing::warn!(error = %e, golden = %golden,
                            "failed to register pool golden snapshot");
                    }
                }
                tracing::info!(golden = %golden, "pool golden registered");
            }
            None => tracing::warn!(
                "warm pool is enabled but no --pool-golden/ORI_POOL_GOLDEN is set; \
                 refill has nothing to clone and the pool will stay empty"
            ),
        }
    }

    // startup pool reconciliation: the provider is truth for existence, so a
    // slot whose container it no longer has is dropped before it is served.
    if let Some(pool) = &state.pool {
        if let Err(e) = pool.reconcile().await {
            tracing::warn!(error = %e, "startup pool reconciliation failed");
        }
    }

    // startup reconciliation: the provider is truth for existence
    if let Err(e) = tasks::reconcile_once(&state).await {
        tracing::warn!(error = %e, "startup reconciliation failed");
    }
    deletion::resume_pending_deletions(&state).await;

    let app = routes::router(state.clone());
    tasks::spawn_reaper(state.clone());
    tasks::spawn_reconciler(state.clone());
    if let Some(pool) = &state.pool {
        pool.spawn_refill();
    }

    let listener = TcpListener::bind(config.listen_addr).await?;
    tracing::info!(
        addr = %config.listen_addr,
        db = %config.database_path.display(),
        provider = %state.provider.name(),
        pool_depth = state.pool.as_ref().map(|p| p.config().depth).unwrap_or(0),
        "ori control plane listening"
    );
    axum::serve(listener, app).await?;

    // on shutdown, destroy every pool instance rather than leave it running
    if let Some(pool) = &state.pool {
        if let Err(e) = pool.drain().await {
            tracing::warn!(error = %e, "pool drain on shutdown failed");
        }
    }
    Ok(())
}
