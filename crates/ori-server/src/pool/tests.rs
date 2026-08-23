//! Pool tests (plans/C5-pool.md "Done means"):
//!
//! - 50 concurrent claims against a pool of 10 → exactly 10 distinct winners,
//!   40 clean misses. Deterministic, at the database level.
//! - A released slot is destroyed, never re-pooled.
//! - Refill clones from the golden snapshot (no cold creates) and serves
//!   already-started instances.
//! - Claim-path latency stays under the `docs/BENCHMARKS.md` budget (≤1.5 s)
//!   against a provider with injected latency.

use std::collections::HashSet;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::{ClaimResult, PoolConfig, PoolKey, PoolManager};
use crate::db;
use crate::mock::MockProvider;
use crate::proto::{
    Addresses, Capabilities, ExecRequest, ExecResult, HostCapacity, InstanceHandle, InstanceSpec,
    InstanceStatus, MachineType, Provider, ProviderError, SnapshotRef, StopMode,
};
use crate::util::now_ts;

/// Sequential suffix so every test gets its own shared in-memory database —
/// parallel tests must never share (or clobber) a backing store.
static DB_SEQ: AtomicU64 = AtomicU64::new(0);

/// A multi-connection database for tests that genuinely exercise concurrent
/// writers. Plain `:memory:` is per-connection, so these use a **named**
/// shared-cache in-memory database (`file:<name>?mode=memory&cache=shared`):
/// every connection in the pool sees the same DB, no two tests share a name,
/// and there is no temp file to collide on.
async fn test_db() -> SqlitePool {
    let seq = DB_SEQ.fetch_add(1, Ordering::SeqCst);
    let uri = format!("sqlite:file:ori_pool_test_{seq}?mode=memory&cache=shared");
    let opts = SqliteConnectOptions::from_str(&uri)
        .expect("shared in-memory uri")
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(15));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await
        .expect("test db connect");
    db::migrate(&pool).await.expect("test db migrate");
    pool
}

fn key() -> PoolKey {
    PoolKey {
        provider: "mock".into(),
        machine_type: MachineType::Default,
        environment_version: 1,
    }
}

fn golden() -> SnapshotRef {
    SnapshotRef {
        provider: "mock".into(),
        name: "golden-base".into(),
    }
}

/// Insert a free slot whose handle is a real (running) mock instance.
async fn seed_slot(db: &SqlitePool, provider: &MockProvider, key: &PoolKey, tag: &str) -> String {
    let spec = InstanceSpec {
        id: format!("seed-{tag}"),
        name: format!("seed-{tag}"),
        machine_type: key.machine_type,
        environment: "base".into(),
        environment_version: key.environment_version,
        env_vars: Default::default(),
    };
    let h = provider.create(&spec).await.unwrap();
    let slot_id = format!("slot-{tag}");
    sqlx::query(
        "INSERT INTO pool_slots (id, pool_key, instance_handle, state, created_at) \
         VALUES (?, ?, ?, 'available', ?)",
    )
    .bind(&slot_id)
    .bind(key.key_string())
    .bind(&h.id)
    .bind(now_ts())
    .execute(db)
    .await
    .unwrap();
    slot_id
}

// ---------------------------------------------------------------------------
// The atomic-claim concurrency test
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn fifty_concurrent_claims_against_ten_slots_yield_exactly_ten_winners() {
    let db = test_db().await;
    let provider = Arc::new(MockProvider::new());
    let pm = PoolManager::new(db.clone(), provider.clone(), PoolConfig::default());
    let key = key();

    // a pool of 10 free slots
    for i in 0..10 {
        sqlx::query(
            "INSERT INTO pool_slots (id, pool_key, instance_handle, state, created_at) \
             VALUES (?, ?, ?, 'available', ?)",
        )
        .bind(format!("slot-{i}"))
        .bind(key.key_string())
        .bind(format!("{i}"))
        .bind(now_ts())
        .execute(&db)
        .await
        .unwrap();
    }
    assert_eq!(pm.available_count(&key).await.unwrap(), 10);

    // 50 simultaneous claims. The atomic single-statement claim is the whole
    // defence against double-issue — no application-level lock.
    let mut tasks = Vec::new();
    for i in 0..50 {
        let pm = pm.clone();
        let key = key.clone();
        tasks.push(tokio::spawn(async move {
            pm.claim(&key, &format!("sandbox-{i}")).await.unwrap()
        }));
    }

    let mut winners = HashSet::new();
    let mut misses = 0usize;
    for t in tasks {
        match t.await.unwrap() {
            ClaimResult::Hit(slot) => {
                winners.insert(slot.instance_handle.id);
            }
            ClaimResult::Miss => misses += 1,
        }
    }

    // exactly 10 distinct winners, 40 clean misses — never a duplicate claim
    assert_eq!(
        winners.len(),
        10,
        "two concurrent creates received the same container; winners = {winners:?}"
    );
    assert_eq!(misses, 40, "expected 40 clean misses, got {misses}");

    // the DB agrees: 10 claimed rows, 0 still available
    let (claimed, available): (i64, i64) = sqlx::query_as(
        "SELECT \
         (SELECT count(*) FROM pool_slots WHERE state = 'claimed'), \
         (SELECT count(*) FROM pool_slots WHERE state = 'available')",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(claimed, 10);
    assert_eq!(available, 0);

    // each winner was claimed by a distinct sandbox id
    let claimed_by = pm.claimed_by(&key).await.unwrap();
    assert_eq!(claimed_by.len(), 10);
}

// ---------------------------------------------------------------------------
// Release destroys; it never re-pools
// ---------------------------------------------------------------------------

#[tokio::test]
async fn released_slot_is_destroyed_not_returned_to_the_pool() {
    let db = test_db().await;
    let provider = Arc::new(MockProvider::new());
    let pm = PoolManager::new(db.clone(), provider.clone(), PoolConfig::default());
    let key = key();

    let slot_a = seed_slot(&db, &provider, &key, "a").await;
    let _slot_b = seed_slot(&db, &provider, &key, "b").await;

    let claim = pm.claim(&key, "sandbox-a").await.unwrap();
    let ClaimResult::Hit(slot_a_claimed) = claim else {
        panic!("pool miss on a seeded pool");
    };
    assert_eq!(slot_a_claimed.slot_id, slot_a);
    let handle_a = slot_a_claimed.instance_handle.id.clone();
    assert!(provider
        .registry
        .lock()
        .unwrap()
        .instances
        .contains_key(&handle_a));

    let destroys_before = provider.registry.lock().unwrap().destroy_calls;
    pm.release(&slot_a).await.unwrap();

    // the container was destroyed
    assert_eq!(
        provider.registry.lock().unwrap().destroy_calls,
        destroys_before + 1
    );
    assert!(!provider
        .registry
        .lock()
        .unwrap()
        .instances
        .contains_key(&handle_a));

    // the slot row is gone, so it can never be handed out again
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM pool_slots WHERE id = ?")
        .bind(&slot_a)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(n, 0, "released slot must not remain in the pool");

    // available count did not grow — the released instance was not re-pooled
    assert_eq!(pm.available_count(&key).await.unwrap(), 1);

    // releasing twice is a no-op (restart-mid-release safety)
    pm.release(&slot_a).await.unwrap();
    assert_eq!(
        provider.registry.lock().unwrap().destroy_calls,
        destroys_before + 1
    );
}

// ---------------------------------------------------------------------------
// Reconcile + drain
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reconcile_drops_slots_whose_instance_is_gone_and_orphaned_claims() {
    let db = test_db().await;
    let provider = Arc::new(MockProvider::new());
    let pm = PoolManager::new(db.clone(), provider.clone(), PoolConfig::default());
    let key = key();

    let slot_a = seed_slot(&db, &provider, &key, "a").await;
    let slot_b = seed_slot(&db, &provider, &key, "b").await;
    let slot_c = seed_slot(&db, &provider, &key, "c").await;

    // distinct created_at so claims are deterministic (claim takes the oldest)
    sqlx::query("UPDATE pool_slots SET created_at = '2026-01-01T00:00:02Z' WHERE id = ?")
        .bind(&slot_a)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE pool_slots SET created_at = '2026-01-01T00:00:01Z' WHERE id = ?")
        .bind(&slot_b)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE pool_slots SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?")
        .bind(&slot_c)
        .execute(&db)
        .await
        .unwrap();

    // slot C is claimed for a sandbox that does not exist (crash between
    // claim and registration)
    let claim = pm.claim(&key, "gone-sandbox").await.unwrap();
    assert!(matches!(claim, ClaimResult::Hit(s) if s.slot_id == slot_c));

    // slot B's instance is destroyed behind the pool's back
    let (handle_b,): (String,) =
        sqlx::query_as::<_, (String,)>("SELECT instance_handle FROM pool_slots WHERE id = ?")
            .bind(&slot_b)
            .fetch_one(&db)
            .await
            .unwrap();
    provider
        .destroy(&InstanceHandle {
            provider: "mock".into(),
            id: handle_b.clone(),
        })
        .await
        .unwrap();

    let destroys_before = provider.registry.lock().unwrap().destroy_calls;
    pm.reconcile().await.unwrap();

    // B dropped (provider no longer has it — never handed out), C released
    // (orphaned claim), A survives untouched.
    let remaining: Vec<String> =
        sqlx::query_as::<_, (String,)>("SELECT id FROM pool_slots ORDER BY id")
            .fetch_all(&db)
            .await
            .unwrap()
            .into_iter()
            .map(|(i,)| i)
            .collect();
    assert_eq!(
        remaining,
        vec![slot_a.clone()],
        "stale slots must be dropped"
    );

    // reconcile destroyed exactly the orphaned claim's container
    assert_eq!(
        provider.registry.lock().unwrap().destroy_calls,
        destroys_before + 1
    );
    assert!(!provider
        .registry
        .lock()
        .unwrap()
        .instances
        .contains_key(&handle_b));
}

#[tokio::test]
async fn drain_destroys_every_pool_instance_on_shutdown() {
    let db = test_db().await;
    let provider = Arc::new(MockProvider::new());
    let pm = PoolManager::new(db.clone(), provider.clone(), PoolConfig::default());
    let key = key();

    for t in ["a", "b", "c"] {
        seed_slot(&db, &provider, &key, t).await;
    }
    assert_eq!(pm.available_count(&key).await.unwrap(), 3);

    let n = pm.drain().await.unwrap();
    assert_eq!(n, 3);
    assert_eq!(provider.registry.lock().unwrap().destroy_calls, 3);
    assert!(provider.registry.lock().unwrap().instances.is_empty());
    let (left,): (i64,) = sqlx::query_as("SELECT count(*) FROM pool_slots")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

// ---------------------------------------------------------------------------
// Refill clones from the golden snapshot
// ---------------------------------------------------------------------------

#[tokio::test]
async fn refill_clones_from_the_golden_and_serves_running_instances() {
    let db = test_db().await;
    let provider = Arc::new(MockProvider::new());
    let config = PoolConfig {
        depth: 10,
        max_concurrent_refills: 10,
        ..PoolConfig::default()
    };
    let pm = PoolManager::new(db.clone(), provider.clone(), config);
    let key = key();

    pm.register_golden(&key, "base", &golden()).await.unwrap();
    let added = pm.refill_key(&key).await.unwrap();
    assert_eq!(added, 10);
    assert_eq!(pm.available_count(&key).await.unwrap(), 10);

    // the pool is filled by cloning from the golden — never a cold create —
    // and every instance is already started
    {
        let reg = provider.registry.lock().unwrap();
        assert_eq!(reg.create_calls, 0, "refill must not cold-create");
        assert_eq!(reg.instances.len(), 10);
        assert!(reg
            .instances
            .values()
            .all(|i| i.state == InstanceStatus::Running));
    }

    // a second pass tops nothing up
    let added = pm.refill_key(&key).await.unwrap();
    assert_eq!(added, 0);

    // without a golden, refill does nothing (cold path stays cold)
    let other = PoolKey {
        machine_type: MachineType::Small,
        ..key.clone()
    };
    assert_eq!(pm.refill_key(&other).await.unwrap(), 0);
}

// ---------------------------------------------------------------------------
// Claim-path latency budget (docs/BENCHMARKS.md: `new` (pool hit) ≤ 1.5 s)
// ---------------------------------------------------------------------------

/// Wraps `MockProvider` and injects per-exec latency so the benchmark models a
/// real backend's round trips (the measured warm claim is 0.89 s of config
/// injection + probe).
struct LatencyProvider {
    inner: MockProvider,
    exec_delay: Duration,
}

impl LatencyProvider {
    fn new(inner: MockProvider, exec_delay: Duration) -> Self {
        LatencyProvider { inner, exec_delay }
    }
}

#[async_trait]
impl Provider for LatencyProvider {
    fn name(&self) -> &'static str {
        "mock"
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn capabilities(&self) -> Capabilities {
        self.inner.capabilities()
    }
    async fn capacity(&self) -> Result<HostCapacity, ProviderError> {
        self.inner.capacity().await
    }
    async fn create(&self, spec: &InstanceSpec) -> Result<InstanceHandle, ProviderError> {
        self.inner.create(spec).await
    }
    async fn clone_from(
        &self,
        src: &SnapshotRef,
        spec: &InstanceSpec,
    ) -> Result<InstanceHandle, ProviderError> {
        self.inner.clone_from(src, spec).await
    }
    async fn start(&self, h: &InstanceHandle) -> Result<(), ProviderError> {
        self.inner.start(h).await
    }
    async fn stop(&self, h: &InstanceHandle, mode: StopMode) -> Result<(), ProviderError> {
        self.inner.stop(h, mode).await
    }
    async fn destroy(&self, h: &InstanceHandle) -> Result<(), ProviderError> {
        self.inner.destroy(h).await
    }
    async fn status(&self, h: &InstanceHandle) -> Result<InstanceStatus, ProviderError> {
        self.inner.status(h).await
    }
    async fn snapshot(&self, h: &InstanceHandle, name: &str) -> Result<SnapshotRef, ProviderError> {
        self.inner.snapshot(h, name).await
    }
    async fn rollback(&self, h: &InstanceHandle, s: &SnapshotRef) -> Result<(), ProviderError> {
        self.inner.rollback(h, s).await
    }
    async fn snapshot_delete(&self, s: &SnapshotRef) -> Result<(), ProviderError> {
        self.inner.snapshot_delete(s).await
    }
    async fn exec(
        &self,
        h: &InstanceHandle,
        req: &ExecRequest,
    ) -> Result<ExecResult, ProviderError> {
        tokio::time::sleep(self.exec_delay).await;
        self.inner.exec(h, req).await
    }
    async fn resize(&self, h: &InstanceHandle, t: MachineType) -> Result<(), ProviderError> {
        self.inner.resize(h, t).await
    }
    async fn addresses(&self, h: &InstanceHandle) -> Result<Addresses, ProviderError> {
        self.inner.addresses(h).await
    }
}

#[tokio::test]
async fn claim_path_stays_under_the_one_point_five_second_budget() {
    let db = test_db().await;
    // 300 ms per exec round trip, i.e. a backend slower than the measured
    // 0.90 s `pct exec` floor (docs/BENCHMARKS.md).
    let lp = Arc::new(LatencyProvider::new(
        MockProvider::new(),
        Duration::from_millis(300),
    ));
    let provider: Arc<dyn Provider> = lp.clone();
    let pm = PoolManager::new(db, provider.clone(), PoolConfig::default());
    let key = key();
    pm.register_golden(&key, "base", &golden()).await.unwrap();
    pm.refill_key(&key).await.unwrap();

    let started = Instant::now();
    // claim path = claim slot → inject env/secrets → set hostname
    let claim = pm.claim(&key, "bench").await.unwrap();
    let ClaimResult::Hit(slot) = claim else {
        panic!("pool miss on a freshly refilled pool");
    };
    let req = ExecRequest {
        cmd: vec!["inject".into()],
        cwd: None,
        timeout_secs: None,
        env: Default::default(),
    };
    provider.exec(&slot.instance_handle, &req).await.unwrap(); // inject env vars
    provider.exec(&slot.instance_handle, &req).await.unwrap(); // inject secret files
    provider.exec(&slot.instance_handle, &req).await.unwrap(); // set hostname
    let elapsed = started.elapsed();

    // 3 × 300 ms injected + the atomic claim (SQL, ~0). Target ≤ 1.5 s.
    assert!(
        elapsed < Duration::from_millis(1500),
        "claim path took {elapsed:?} — over the 1.5 s budget"
    );
    // and the latency really was exercised (otherwise this asserts nothing)
    assert!(
        elapsed >= Duration::from_millis(800),
        "injected latency did not register — {elapsed:?}"
    );
}

// ---------------------------------------------------------------------------
// PoolKey round-trip
// ---------------------------------------------------------------------------

#[test]
fn pool_key_round_trips() {
    let k = key();
    let parsed = PoolKey::parse(&k.key_string()).unwrap();
    assert_eq!(parsed, k);
    assert_eq!(
        PoolKey::parse("proxmox|large|3").unwrap().machine_type,
        MachineType::Large
    );
    assert_eq!(
        PoolKey::parse("proxmox|large|3")
            .unwrap()
            .environment_version,
        3
    );
    assert!(PoolKey::parse("not-a-key").is_err());
    assert!(PoolKey::parse("proxmox|bogus|1").is_err());
    assert!(PoolKey::parse("proxmox|default|").is_err());
}
