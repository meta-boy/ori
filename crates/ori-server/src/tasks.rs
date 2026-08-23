//! Background tasks: the TTL reaper and the provider reconciliation loop.
//!
//! Reaper: when `stopAfter` is reached, transition to `stopping` and power
//! off. The transition is guarded in SQL so a restart mid-reap cannot
//! double-stop a sandbox. `no-auto-stop` (null `stop_after`) is skipped.
//!
//! Reconciler: the provider is truth for existence, the DB is truth for
//! intent. A sandbox we call `ready` that the provider says is gone goes to
//! `error`; a provider instance we do not know about is an orphan to destroy.

use std::collections::HashSet;

use tokio::time::MissedTickBehavior;

use crate::error::ApiResult;
use crate::mock::MockProvider;
use crate::proto::{BoxState, InstanceHandle, InstanceStatus, Provider, StopMode};
use crate::repo;
use crate::state::AppState;
use crate::util::now_ts;

pub async fn reap_expired(state: &AppState) -> ApiResult<()> {
    let now = now_ts();
    let rows = repo::sandboxes_in_states(&state.db, &["ready", "running", "idle"]).await?;
    for row in rows {
        let Some(stop_after) = row.stop_after.clone() else {
            continue;
        };
        if stop_after > now {
            continue;
        }
        // Guarded claim: only one pass (or a concurrent stop request) wins.
        if !repo::transition(
            &state.db,
            &row.id,
            &["ready", "running", "idle"],
            BoxState::Stopping,
        )
        .await?
        {
            continue;
        }
        let handle = InstanceHandle {
            provider: row.provider.clone(),
            id: row.provider_handle.clone(),
        };
        // C12: power off first, then snapshot while stopped. The provider's
        // `Snapshot` stop mode snapshots *before* powering off, which produces
        // a running-taken snapshot that is permanently ~20x slower to clone
        // from; the reaper instead stops with `Force` and snapshots after, so
        // a reaped sandbox carries a fast-cloneable stopped snapshot for fork.
        match state.provider.stop(&handle, StopMode::Force).await {
            Ok(()) => {
                if let Ok(snap) = state
                    .provider
                    .snapshot(&handle, &crate::util::snapshot_name("ttl"))
                    .await
                {
                    let _ = repo::insert_snapshot(
                        &state.db,
                        &row.account_id,
                        &row.id,
                        "ttl",
                        &snap.name,
                        true,
                    )
                    .await;
                }
                repo::set_state(&state.db, &row.id, BoxState::Stopped).await?;
            }
            Err(e) => {
                tracing::warn!(sandbox = %row.id, error = %e, "reaper stop failed");
                repo::set_state(&state.db, &row.id, BoxState::Error).await?;
            }
        }
    }
    Ok(())
}

pub async fn reconcile_once(state: &AppState) -> ApiResult<()> {
    // 1. Drift: a sandbox we think is up that the provider says is gone.
    let rows = repo::sandboxes_in_states(&state.db, &["ready", "running", "idle"]).await?;
    for row in rows {
        let handle = InstanceHandle {
            provider: row.provider.clone(),
            id: row.provider_handle.clone(),
        };
        let gone = matches!(
            state.provider.status(&handle).await,
            Ok(InstanceStatus::Stopped)
                | Ok(InstanceStatus::Missing)
                // a provider that answers 404 has no such instance
                | Err(crate::proto::ProviderError::NotFound(_))
        );
        if gone {
            tracing::warn!(
                sandbox = %row.id,
                handle = %handle,
                "reconciler demoted sandbox to error: provider no longer reports it up"
            );
            let _ = repo::transition(
                &state.db,
                &row.id,
                &["ready", "running", "idle"],
                BoxState::Error,
            )
            .await;
        }
    }

    // 2. Orphans: provider instances with no DB sandbox. The trait has no
    //    enumeration method, so only the mock (which can) is reconciled for
    //    orphans; real providers get drift-only reconciliation until the
    //    real provider lands with its own inventory.
    if let Some(mock) = state.provider.as_any().downcast_ref::<MockProvider>() {
        let db_handles: Vec<(String,)> = sqlx::query_as(
            "SELECT provider_handle FROM sandboxes WHERE provider = 'mock' AND deleted_at IS NULL",
        )
        .fetch_all(&state.db)
        .await?;
        let known: HashSet<String> = db_handles.into_iter().map(|(h,)| h).collect();
        let mock_ids: Vec<String> = mock
            .registry
            .lock()
            .unwrap()
            .instances
            .keys()
            .cloned()
            .collect();
        for id in mock_ids {
            // provider_handle stores the provider-scoped id only, so the
            // registry keys compare directly against it.
            if !known.contains(&id) {
                let handle = InstanceHandle {
                    provider: "mock".into(),
                    id: id.clone(),
                };
                let _ = mock.destroy(&handle).await;
                tracing::info!(instance = %handle, "reconciler destroyed orphan");
            }
        }
    }
    Ok(())
}

pub fn spawn_reaper(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(state.config.reap_interval);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if let Err(e) = reap_expired(&state).await {
                tracing::warn!(error = %e, "reaper pass failed");
            }
        }
    });
}

pub fn spawn_reconciler(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(state.config.reconcile_interval);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if let Err(e) = reconcile_once(&state).await {
                tracing::warn!(error = %e, "reconcile pass failed");
            }
        }
    });
}
