//! Warm pool manager (plans/C5-pool.md).
//!
//! `ori new` cannot boot a machine in under a second, so the pool is the
//! design, not an optimization: each `PoolKey` (provider × machine type ×
//! environment version) keeps `depth` pre-created, **already started**
//! containers, linked-cloned (`full=0`) from a golden snapshot registered for
//! that key. Claiming one is a single atomic SQL statement — the database,
//! not application locking, makes double-issue impossible.
//!
//! Rules enforced here:
//!
//! - **A claim is one `UPDATE ... RETURNING`.** Two concurrent `ori new`
//!   calls can never receive the same container: one tenant's secrets inside
//!   another tenant's sandbox is the worst failure this system can produce,
//!   so it must be impossible at the database level, not merely unlikely
//!   under the application's locking.
//! - **A released instance is destroyed, never re-pooled.** Scrubbing a used
//!   container well enough to hand to a different tenant is not a thing to be
//!   clever about; `release` destroys it and the slot row is deleted.
//! - **Refill is background-only**, linked clone + start, rate-limited by a
//!   semaphore (`max_concurrent_refills` — 8 parallel clones on this 8-core
//!   host is already contention) and never on a request path.
//! - **Startup reconciliation** drops slots whose container the provider no
//!   longer has, so a stale slot is never handed out.
//! - **Golden rebuilds take a cross-server lock** (`pool_locks`); superseded
//!   versions are drained, not reused.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use sqlx::SqlitePool;
use tokio::sync::Semaphore;

use crate::proto::{InstanceHandle, InstanceSpec, MachineType, Provider, SnapshotRef};
use crate::util::now_ts;

// ---------------------------------------------------------------------------
// Pool key
// ---------------------------------------------------------------------------

/// Identity of a warm-pool population: `provider|machine_type|environment_version`.
/// Each key clones from its own golden snapshot and is drained independently
/// when that version is superseded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolKey {
    pub provider: String,
    pub machine_type: MachineType,
    pub environment_version: i64,
}

impl PoolKey {
    /// Stable string form stored in `pool_slots.pool_key`.
    pub fn key_string(&self) -> String {
        format!(
            "{}|{}|{}",
            self.provider,
            machine_type_str(self.machine_type),
            self.environment_version
        )
    }

    pub fn parse(s: &str) -> Result<PoolKey, PoolError> {
        let mut parts = s.split('|');
        let provider = parts
            .next()
            .filter(|p| !p.is_empty())
            .ok_or_else(|| PoolError::InvalidKey(s.to_string(), "missing provider".into()))?
            .to_string();
        let machine = parts
            .next()
            .ok_or_else(|| PoolError::InvalidKey(s.to_string(), "missing machine_type".into()))?
            .parse::<MachineType>()
            .map_err(|e| PoolError::InvalidKey(s.to_string(), e))?;
        let version = parts
            .next()
            .ok_or_else(|| {
                PoolError::InvalidKey(s.to_string(), "missing environment_version".into())
            })?
            .parse::<i64>()
            .map_err(|e| PoolError::InvalidKey(s.to_string(), e.to_string()))?;
        if parts.next().is_some() {
            return Err(PoolError::InvalidKey(
                s.to_string(),
                "too many components".into(),
            ));
        }
        Ok(PoolKey {
            provider,
            machine_type: machine,
            environment_version: version,
        })
    }
}

fn machine_type_str(m: MachineType) -> &'static str {
    match m {
        MachineType::Small => "small",
        MachineType::Default => "default",
        MachineType::Large => "large",
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum PoolError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("provider error: {0}")]
    Provider(#[from] crate::proto::ProviderError),
    #[error("invalid pool key {0:?}: {1}")]
    InvalidKey(String, String),
    #[error("{0}")]
    Other(String),
}

// ---------------------------------------------------------------------------
// Claim result
// ---------------------------------------------------------------------------

/// A claimed slot. The instance is **not** returned to the pool: whoever
/// claims it owns it until `release`, which destroys it.
#[derive(Debug, Clone)]
pub struct ClaimedSlot {
    pub slot_id: String,
    pub pool_key: PoolKey,
    pub instance_handle: InstanceHandle,
}

#[derive(Debug)]
pub enum ClaimResult {
    /// Pool hit — a pre-started, ready instance.
    Hit(ClaimedSlot),
    /// Pool miss — no free slot; the caller must take the cold path.
    Miss,
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PoolConfig {
    /// Target number of available (unclaimed) slots per key.
    pub depth: usize,
    /// Max concurrent clones/starts across the whole pool. On the measured
    /// 8-core host, 8 parallel clones is already contention.
    pub max_concurrent_refills: usize,
    /// Refill loop cadence. Refill is never on a request path.
    pub refill_interval: Duration,
}

impl Default for PoolConfig {
    fn default() -> Self {
        PoolConfig {
            depth: 8,
            max_concurrent_refills: 8,
            refill_interval: Duration::from_secs(30),
        }
    }
}

// ---------------------------------------------------------------------------
// PoolManager
// ---------------------------------------------------------------------------

/// The `PoolManager` API the create handler (C3) drives. It owns no request
/// path work beyond the atomic claim; refill, reconciliation, golden rebuild
/// and drain all run off the request path.
#[derive(Clone)]
pub struct PoolManager {
    db: SqlitePool,
    provider: Arc<dyn Provider>,
    config: PoolConfig,
    refill_sem: Arc<Semaphore>,
}

impl PoolManager {
    pub fn new(db: SqlitePool, provider: Arc<dyn Provider>, config: PoolConfig) -> Self {
        PoolManager {
            db,
            provider,
            config: config.clone(),
            refill_sem: Arc::new(Semaphore::new(config.max_concurrent_refills.max(1))),
        }
    }

    /// Read-only, for tests and admin tooling.
    pub fn config(&self) -> &PoolConfig {
        &self.config
    }

    pub fn provider(&self) -> Arc<dyn Provider> {
        self.provider.clone()
    }

    // -----------------------------------------------------------------------
    // Golden snapshot registry
    // -----------------------------------------------------------------------

    /// Register (or replace) the golden snapshot a pool key clones from. The
    /// snapshot must have been taken while the source was **stopped** — a
    /// running-taken snapshot is permanently ~20× slower to clone from
    /// (docs/BENCHMARKS.md §Root cause).
    pub async fn register_golden(
        &self,
        key: &PoolKey,
        environment: &str,
        snapshot: &SnapshotRef,
    ) -> Result<(), PoolError> {
        sqlx::query(
            "INSERT OR REPLACE INTO golden_snapshots \
             (id, pool_key, provider, environment, environment_version, machine_type, \
              snapshot_ref, active, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
        )
        .bind(slot_id())
        .bind(key.key_string())
        .bind(&key.provider)
        .bind(environment)
        .bind(key.environment_version)
        .bind(machine_type_str(key.machine_type))
        .bind(&snapshot.name)
        .bind(now_ts())
        .execute(&self.db)
        .await?;
        Ok(())
    }

    async fn golden_for(&self, key: &PoolKey) -> Result<Option<(String, String)>, PoolError> {
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT environment, snapshot_ref FROM golden_snapshots \
             WHERE pool_key = ? AND active = 1",
        )
        .bind(key.key_string())
        .fetch_optional(&self.db)
        .await?;
        Ok(row)
    }

    /// Rebuild a golden for a superseded environment version. Superseded pool
    /// members are drained, not reused. Guarded by `pool_locks` so two control
    /// plane processes sharing this DB cannot rebuild the same key at once.
    /// Returns `Ok(false)` when another process holds the rebuild lock.
    pub async fn rebuild_golden(
        &self,
        key: &PoolKey,
        environment: &str,
        snapshot: &SnapshotRef,
    ) -> Result<bool, PoolError> {
        let lock_key = format!("golden:{}", key.key_string());
        let res = sqlx::query(
            "INSERT OR IGNORE INTO pool_locks (key, holder, created_at) VALUES (?, ?, ?)",
        )
        .bind(&lock_key)
        .bind("golden-rebuild")
        .bind(now_ts())
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Ok(false);
        }
        self.drain_key(key).await?;
        sqlx::query("UPDATE golden_snapshots SET active = 0 WHERE pool_key = ?")
            .bind(key.key_string())
            .execute(&self.db)
            .await?;
        self.register_golden(key, environment, snapshot).await?;
        sqlx::query("DELETE FROM pool_locks WHERE key = ?")
            .bind(&lock_key)
            .execute(&self.db)
            .await?;
        Ok(true)
    }

    // -----------------------------------------------------------------------
    // Atomic claim
    // -----------------------------------------------------------------------

    /// Claim one pre-started instance for `sandbox_id`, atomically. A single
    /// statement: the subquery picks the oldest free slot while holding
    /// SQLite's write lock, so two concurrent claims serialize and can never
    /// read the same free slot. This is the database-level guarantee the whole
    /// pool exists for.
    pub async fn claim(&self, key: &PoolKey, sandbox_id: &str) -> Result<ClaimResult, PoolError> {
        let row: Option<(String, String)> = sqlx::query_as(
            "UPDATE pool_slots \
                SET claimed_by = ?, claimed_at = ?, state = 'claimed' \
              WHERE id = (SELECT id FROM pool_slots \
                           WHERE pool_key = ? AND state = 'available' AND claimed_by IS NULL \
                           ORDER BY created_at LIMIT 1) \
             RETURNING id, instance_handle",
        )
        .bind(sandbox_id)
        .bind(now_ts())
        .bind(key.key_string())
        .fetch_optional(&self.db)
        .await?;
        Ok(match row {
            Some((slot_id, handle)) => ClaimResult::Hit(ClaimedSlot {
                slot_id,
                pool_key: key.clone(),
                instance_handle: InstanceHandle {
                    provider: key.provider.clone(),
                    id: handle,
                },
            }),
            None => ClaimResult::Miss,
        })
    }

    pub async fn available_count(&self, key: &PoolKey) -> Result<usize, PoolError> {
        let (n,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM pool_slots WHERE pool_key = ? AND state = 'available'",
        )
        .bind(key.key_string())
        .fetch_one(&self.db)
        .await?;
        Ok(n as usize)
    }

    // -----------------------------------------------------------------------
    // Release — destroy, never re-pool
    // -----------------------------------------------------------------------

    /// Release a claimed slot: destroy the container and delete the slot row.
    /// The instance is never returned to the pool — scrubbing a used container
    /// well enough to hand to a different tenant is not a thing to be clever
    /// about. Idempotent: releasing an already-released slot is a no-op.
    pub async fn release(&self, slot_id: &str) -> Result<(), PoolError> {
        let claimed: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM pool_slots WHERE id = ? AND state = 'claimed'")
                .bind(slot_id)
                .fetch_optional(&self.db)
                .await?;
        if claimed.is_none() {
            return Ok(());
        }
        self.destroy_slot(slot_id).await
    }

    /// Release whatever a (deleted) sandbox held, by sandbox id. Used when a
    /// deletion operation finishes and by startup reconciliation for orphaned
    /// claims.
    pub async fn release_claimed_by(&self, sandbox_id: &str) -> Result<(), PoolError> {
        let slots: Vec<(String,)> =
            sqlx::query_as("SELECT id FROM pool_slots WHERE claimed_by = ?")
                .bind(sandbox_id)
                .fetch_all(&self.db)
                .await?;
        for (id,) in slots {
            self.release(&id).await?;
        }
        Ok(())
    }

    /// Destroy a slot's container (if any) and drop the row, whatever its
    /// state. Used by release and by reconciliation of stuck `releasing`
    /// slots and orphaned claims.
    async fn destroy_slot(&self, slot_id: &str) -> Result<(), PoolError> {
        let row: Option<(String, String)> = sqlx::query_as(
            "UPDATE pool_slots SET state = 'releasing' WHERE id = ? \
             RETURNING pool_key, instance_handle",
        )
        .bind(slot_id)
        .fetch_optional(&self.db)
        .await?;
        let Some((pk, handle)) = row else {
            return Ok(());
        };
        let key = PoolKey::parse(&pk)?;
        let h = InstanceHandle {
            provider: key.provider.clone(),
            id: handle,
        };
        // `destroy` is idempotent on the provider; a missing instance is Ok.
        let _ = self.provider.destroy(&h).await;
        sqlx::query("DELETE FROM pool_slots WHERE id = ?")
            .bind(slot_id)
            .execute(&self.db)
            .await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Background refill
    // -----------------------------------------------------------------------

    /// Top up one key towards `depth`. Returns the number of slots added.
    /// Per-pass cap of `max_concurrent_refills`; each clone+start holds one
    /// semaphore permit so no more than that run at once. Never called from a
    /// request path.
    pub async fn refill_key(&self, key: &PoolKey) -> Result<usize, PoolError> {
        let Some((environment, snap_ref)) = self.golden_for(key).await? else {
            return Ok(0);
        };
        let (avail,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM pool_slots WHERE pool_key = ? AND state = 'available'",
        )
        .bind(key.key_string())
        .fetch_one(&self.db)
        .await?;
        let need = self.config.depth.saturating_sub(avail as usize);
        if need == 0 {
            return Ok(0);
        }
        let to_fill = need.min(self.config.max_concurrent_refills);
        let mut added = 0usize;
        for _ in 0..to_fill {
            let permit = match self.refill_sem.clone().try_acquire_owned() {
                Ok(p) => p,
                Err(_) => break,
            };
            let id = slot_id();
            let spec = InstanceSpec {
                id: id.clone(),
                name: format!(
                    "pool-{}-{}",
                    machine_type_str(key.machine_type),
                    key.environment_version
                ),
                machine_type: key.machine_type,
                environment: environment.clone(),
                environment_version: key.environment_version,
                env_vars: Default::default(),
            };
            let snap = SnapshotRef {
                provider: key.provider.clone(),
                name: snap_ref.clone(),
            };
            match Provider::clone_from(&*self.provider, &snap, &spec).await {
                Ok(h) => {
                    // clone_from leaves real clones stopped; the pool only
                    // serves already-started instances.
                    if let Err(e) = self.provider.start(&h).await {
                        tracing::warn!(key = %key.key_string(), handle = %h.id, error = %e,
                            "pool refill: start failed; destroying clone");
                        let _ = self.provider.destroy(&h).await;
                    } else {
                        let _ = sqlx::query(
                            "INSERT INTO pool_slots (id, pool_key, instance_handle, state, created_at) \
                             VALUES (?, ?, ?, 'available', ?)",
                        )
                        .bind(&id)
                        .bind(key.key_string())
                        .bind(&h.id)
                        .bind(now_ts())
                        .execute(&self.db)
                        .await;
                        added += 1;
                    }
                }
                Err(e) => {
                    tracing::warn!(key = %key.key_string(), error = %e, "pool refill: clone failed");
                }
            }
            drop(permit);
        }
        Ok(added)
    }

    /// Refill every key with an active golden. Background loop body.
    pub async fn refill_all(&self) -> Result<usize, PoolError> {
        let keys: Vec<(String,)> =
            sqlx::query_as("SELECT pool_key FROM golden_snapshots WHERE active = 1")
                .fetch_all(&self.db)
                .await?;
        let mut total = 0usize;
        for (pk,) in keys {
            if let Ok(key) = PoolKey::parse(&pk) {
                total += self.refill_key(&key).await.unwrap_or(0);
            }
        }
        Ok(total)
    }

    /// Spawn the refill loop. Off the request path by construction.
    pub fn spawn_refill(&self) {
        let this = self.clone();
        let interval = self.config.refill_interval;
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                if let Err(e) = this.refill_all().await {
                    tracing::warn!(error = %e, "pool refill pass failed");
                }
            }
        });
    }

    // -----------------------------------------------------------------------
    // Reconciliation + drain
    // -----------------------------------------------------------------------

    /// Startup reconciliation. The provider is truth for existence: a slot
    /// whose container the provider no longer has is dropped, never handed
    /// out. A `claimed` slot whose sandbox row is gone (crash between claim
    /// and registration) and a stuck `releasing` slot are destroyed too.
    pub async fn reconcile(&self) -> Result<(), PoolError> {
        #[derive(sqlx::FromRow)]
        struct SlotRow {
            id: String,
            pool_key: String,
            instance_handle: String,
            state: String,
            claimed_by: Option<String>,
        }
        let rows: Vec<SlotRow> = sqlx::query_as(
            "SELECT id, pool_key, instance_handle, state, claimed_by FROM pool_slots",
        )
        .fetch_all(&self.db)
        .await?;
        for row in rows {
            let key = match PoolKey::parse(&row.pool_key) {
                Ok(k) => k,
                Err(_) => {
                    // a corrupt key can never be handed out correctly; drop it
                    sqlx::query("DELETE FROM pool_slots WHERE id = ?")
                        .bind(&row.id)
                        .execute(&self.db)
                        .await?;
                    continue;
                }
            };
            let handle = InstanceHandle {
                provider: key.provider.clone(),
                id: row.instance_handle.clone(),
            };
            let gone = matches!(
                self.provider.status(&handle).await,
                Ok(crate::proto::InstanceStatus::Missing)
                    | Err(crate::proto::ProviderError::NotFound(_))
            );
            if gone {
                tracing::warn!(slot = %row.id, handle = %handle,
                    "pool reconcile: provider no longer has the container; dropping slot");
                sqlx::query("DELETE FROM pool_slots WHERE id = ?")
                    .bind(&row.id)
                    .execute(&self.db)
                    .await?;
                continue;
            }
            if row.state == "releasing" {
                self.destroy_slot(&row.id).await?;
                continue;
            }
            if let Some(claimed_by) = &row.claimed_by {
                let (n,): (i64,) = sqlx::query_as(
                    "SELECT count(*) FROM sandboxes WHERE id = ? AND deleted_at IS NULL",
                )
                .bind(claimed_by)
                .fetch_one(&self.db)
                .await?;
                if n == 0 {
                    tracing::warn!(slot = %row.id, sandbox = %claimed_by,
                        "pool reconcile: claim references a missing sandbox; destroying");
                    self.release(&row.id).await?;
                }
            }
        }
        Ok(())
    }

    /// Destroy every pool instance and drop every slot. Called on shutdown.
    /// Returns the number of slots drained.
    pub async fn drain(&self) -> Result<usize, PoolError> {
        let rows: Vec<(String, String, String)> =
            sqlx::query_as("SELECT id, pool_key, instance_handle FROM pool_slots")
                .fetch_all(&self.db)
                .await?;
        let n = rows.len();
        for (id, pk, handle) in rows {
            let key = match PoolKey::parse(&pk) {
                Ok(k) => k,
                Err(_) => continue,
            };
            let _ = self
                .provider
                .destroy(&InstanceHandle {
                    provider: key.provider,
                    id: handle,
                })
                .await;
            let _ = sqlx::query("DELETE FROM pool_slots WHERE id = ?")
                .bind(&id)
                .execute(&self.db)
                .await;
        }
        Ok(n)
    }

    /// Destroy every slot for one key (superseded version). Never reused.
    pub async fn drain_key(&self, key: &PoolKey) -> Result<usize, PoolError> {
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT id, instance_handle FROM pool_slots WHERE pool_key = ?")
                .bind(key.key_string())
                .fetch_all(&self.db)
                .await?;
        let n = rows.len();
        for (id, handle) in rows {
            let _ = self
                .provider
                .destroy(&InstanceHandle {
                    provider: key.provider.clone(),
                    id: handle,
                })
                .await;
            let _ = sqlx::query("DELETE FROM pool_slots WHERE id = ?")
                .bind(&id)
                .execute(&self.db)
                .await;
        }
        Ok(n)
    }

    /// Which sandboxes currently hold a claim. Reconciliation and tests use
    /// this to prove claims map to distinct slots.
    pub async fn claimed_by(&self, key: &PoolKey) -> Result<HashSet<String>, PoolError> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT claimed_by FROM pool_slots WHERE pool_key = ? AND claimed_by IS NOT NULL",
        )
        .bind(key.key_string())
        .fetch_all(&self.db)
        .await?;
        Ok(rows.into_iter().map(|(c,)| c).collect())
    }
}

/// Opaque unique id for slots. CSPRNG-drawn hex, same pattern as `TypedId`.
fn slot_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("CSPRNG failure");
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("orislot_{hex}")
}

#[cfg(test)]
mod tests;
