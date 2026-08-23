//! Async deletion operations. `DELETE` returns the operation id immediately
//! (`oriop_<hex32>`) and the real work happens on a background task with
//! status `pending|processing|blocked|completed`. `blocked` is a real state:
//! when snapshots feature lands, a snapshot with dependent incrementals makes
//! delete return 409 and the operation record why.

use sqlx::SqlitePool;

use crate::error::{ApiError, ApiResult};
use crate::proto::{InstanceHandle, Operation, TypedId};
use crate::state::AppState;
use crate::util::now_ts;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OperationRow {
    pub id: String,
    pub sandbox_id: String,
    pub status: String,
    pub blocked_reason: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

impl OperationRow {
    pub fn to_operation(&self) -> Operation {
        Operation {
            id: self.id.clone(),
            sandbox_id: self.sandbox_id.clone(),
            status: self.status.clone(),
            blocked_reason: self.blocked_reason.clone(),
            error: self.error.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            completed_at: self.completed_at.clone(),
        }
    }
}

pub async fn get_operation(db: &SqlitePool, id: &str) -> ApiResult<Option<OperationRow>> {
    let row = sqlx::query_as::<_, OperationRow>(
        "SELECT id, sandbox_id, status, blocked_reason, error, created_at, updated_at, completed_at \
         FROM deletion_operations WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

/// Create the operation row, soft-delete the sandbox, and hand the actual
/// destroy to a background task. Returns the operation in `pending`.
pub async fn start_delete(
    state: &AppState,
    sandbox_id: &str,
    account_id: &str,
) -> ApiResult<OperationRow> {
    let id = TypedId::deletion_op().to_string();
    let now = now_ts();
    sqlx::query(
        "INSERT INTO deletion_operations (id, account_id, sandbox_id, status, created_at, updated_at) \
         VALUES (?, ?, ?, 'pending', ?, ?)",
    )
    .bind(&id)
    .bind(account_id)
    .bind(sandbox_id)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await?;

    crate::repo::soft_delete(&state.db, sandbox_id).await?;

    let op = get_operation(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("op vanished"))?;
    let state2 = state.clone();
    tokio::spawn(async move { run_deletion(state2, id).await });
    Ok(op)
}

/// Process one deletion operation to completion. Re-entrant: the status
/// transition `pending -> processing` is guarded, so a restart mid-reap does
/// not double-destroy.
async fn run_deletion(state: AppState, op_id: String) {
    let Some(op) = get_operation(&state.db, &op_id).await.ok().flatten() else {
        return;
    };
    if op.status != "pending" {
        return;
    }
    if let Err(e) = sqlx::query(
        "UPDATE deletion_operations SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(now_ts())
    .bind(&op_id)
    .execute(&state.db)
    .await
    {
        tracing::error!(op = %op_id, error = %e, "deletion processing claim failed");
        return;
    }

    // blocked: a snapshot with dependent incrementals cannot be deleted. Check
    // before clearing rows — a dependent lives on another sandbox, so the
    // clear would hide nothing — and record *why* rather than leaving the
    // operation in `pending` forever.
    let blocked = deletion_blocked(&state, &op.sandbox_id).await;
    if let Some(reason) = blocked {
        let _ = sqlx::query(
            "UPDATE deletion_operations SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?",
        )
        .bind(&reason)
        .bind(now_ts())
        .bind(&op_id)
        .execute(&state.db)
        .await;
        return;
    }

    // The container is being destroyed, so its snapshots die with it. Clear
    // the rows before destroy (best-effort).
    if let Err(e) = sqlx::query("DELETE FROM snapshots WHERE sandbox_id = ?")
        .bind(&op.sandbox_id)
        .execute(&state.db)
        .await
    {
        tracing::error!(op = %op_id, error = %e, "deletion: clearing snapshot rows failed");
    }

    let Some(sandbox) = crate::repo::get_sandbox_including_deleted(&state.db, &op.sandbox_id)
        .await
        .ok()
        .flatten()
    else {
        let _ = complete_op(&state, &op_id, None).await;
        return;
    };

    let handle = InstanceHandle {
        provider: sandbox.provider.clone(),
        id: sandbox.provider_handle.clone(),
    };
    match state.provider.destroy(&handle).await {
        Ok(()) => {
            let _ = complete_op(&state, &op_id, None).await;
        }
        Err(e) => {
            // keep the op non-terminal so the operator can retry; record why
            let _ = sqlx::query(
                "UPDATE deletion_operations SET status = 'blocked', error = ?, updated_at = ? WHERE id = ?",
            )
            .bind(e.to_string())
            .bind(now_ts())
            .bind(&op_id)
            .execute(&state.db)
            .await;
        }
    }
}

async fn complete_op(state: &AppState, op_id: &str, err: Option<&str>) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE deletion_operations SET status = 'completed', error = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(err)
    .bind(now_ts())
    .bind(now_ts())
    .bind(op_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Returns a block reason if the sandbox cannot be deleted yet.
///
/// The blocking case is a **dependent incremental**: a snapshot whose parent
/// chain references a snapshot of this sandbox (e.g. a forked sandbox built
/// incrementally on this sandbox's stopped-taken snapshot). Deleting the
/// parent snapshot would orphan it. A sandbox's own snapshots are *not* a
/// block — they die with the container.
async fn deletion_blocked(state: &AppState, sandbox_id: &str) -> Option<String> {
    let row: (i64,) = sqlx::query_as(
        "SELECT count(*) FROM snapshots s \
         WHERE s.parent_id IN (SELECT id FROM snapshots WHERE sandbox_id = ?)",
    )
    .bind(sandbox_id)
    .fetch_one(&state.db)
    .await
    .ok()?;
    if row.0 > 0 {
        Some(format!(
            "{count} dependent snapshot(s) are built on this sandbox's snapshots; \
             a snapshot with dependent incrementals cannot be deleted",
            count = row.0
        ))
    } else {
        None
    }
}

/// Re-claim `pending` operations left over from a previous run (crash before
/// completion) and process them.
pub async fn resume_pending_deletions(state: &AppState) {
    let pending: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM deletion_operations WHERE status = 'pending'")
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();
    for (id,) in pending {
        let state2 = state.clone();
        tokio::spawn(async move { run_deletion(state2, id).await });
    }
}
