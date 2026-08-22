-- C5 — warm pool (plans/C5-pool.md). Delivered with `crates/ori-server/src/pool/**`.
--
-- `pool_slots` (0001) already reserves the claim shape; the column the claim
-- statement returns is renamed to `instance_handle` so the atomic
-- `UPDATE ... RETURNING` reads naturally. `golden_snapshots` is the registry
-- the background refill clones from (linked clone, `full=0`, snapshot taken
-- while stopped — see docs/BENCHMARKS.md). `pool_locks` is a cross-server
-- lock for golden rebuilds: two control-plane processes share this SQLite file
-- and must never rebuild the same key concurrently.

ALTER TABLE pool_slots RENAME COLUMN provider_handle TO instance_handle;

CREATE TABLE golden_snapshots (
  id                   TEXT PRIMARY KEY,       -- opaque slot id
  pool_key             TEXT NOT NULL UNIQUE,   -- provider|machine_type|env_version
  provider             TEXT NOT NULL,
  environment          TEXT NOT NULL DEFAULT 'base',
  environment_version  INTEGER NOT NULL,
  machine_type         TEXT NOT NULL,          -- small|default|large
  snapshot_ref         TEXT NOT NULL,          -- opaque provider-scoped snapshot ref
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL
);

CREATE TABLE pool_locks (
  key                  TEXT PRIMARY KEY,
  holder               TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE INDEX idx_pool_slots_claim ON pool_slots (pool_key, claimed_by);
CREATE INDEX idx_pool_slots_state ON pool_slots (state);