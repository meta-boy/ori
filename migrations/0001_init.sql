-- ori control-plane schema. One file, SQLite WAL.
-- Every table that hands out a shared resource (vmid, pool slot, name, slug,
-- secret key) has a uniqueness constraint so the database refuses a
-- double-issue rather than relying on application-level checks.

CREATE TABLE sandboxes (
  id                     TEXT PRIMARY KEY,               -- ori_ + 8 [a-z0-9]
  account_id             TEXT NOT NULL DEFAULT 'default',
  name                   TEXT NOT NULL,
  state                  TEXT NOT NULL,
  machine_type           TEXT NOT NULL,                  -- small|default|large
  slug                   TEXT NOT NULL,
  provider               TEXT NOT NULL,
  provider_handle        TEXT NOT NULL,
  environment            TEXT NOT NULL DEFAULT 'base',
  environment_version    INTEGER NOT NULL DEFAULT 1,
  no_env                 INTEGER NOT NULL DEFAULT 0,
  ip                     TEXT,
  url                    TEXT,
  ssh_endpoint           TEXT,
  desktop_available      INTEGER NOT NULL DEFAULT 0,
  desktop_url            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  stop_after             TEXT,
  snapshot_available     INTEGER NOT NULL DEFAULT 0,
  last_snapshot_attempt_at TEXT,
  last_snapshot_status   TEXT,
  snapshot_completed_at  TEXT,
  setup_status           TEXT,
  setup_error            TEXT,
  team                   TEXT,
  deleted_at             TEXT,
  UNIQUE (account_id, slug)
);

CREATE INDEX idx_sandboxes_state ON sandboxes (state);
CREATE INDEX idx_sandboxes_account_state ON sandboxes (account_id, state);
CREATE INDEX idx_sandboxes_stop_after ON sandboxes (stop_after) WHERE stop_after IS NOT NULL;
CREATE INDEX idx_sandboxes_deleted ON sandboxes (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE api_keys (
  id                     TEXT PRIMARY KEY,               -- orik_ + 32 hex
  account_id             TEXT NOT NULL DEFAULT 'default',
  name                   TEXT,
  prefix                 TEXT NOT NULL,
  last_four              TEXT NOT NULL,
  key_hash               TEXT NOT NULL,                  -- argon2 PHC string
  created_at             TEXT NOT NULL,
  revoked_at             TEXT
);

CREATE INDEX idx_api_keys_active ON api_keys (revoked_at) WHERE revoked_at IS NULL;

CREATE TABLE device_codes (
  id                     TEXT PRIMARY KEY,               -- orid_ + 32 hex
  account_id             TEXT NOT NULL DEFAULT 'default',
  user_code              TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending',-- pending|approved|expired
  key_id                 TEXT,
  token                  TEXT,                           -- hand-off secret, cleared after first poll
  token_issued           INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  expires_at             TEXT NOT NULL,
  approved_at            TEXT,
  UNIQUE (account_id, user_code)
);

CREATE TABLE deletion_operations (
  id                     TEXT PRIMARY KEY,               -- oriop_ + 32 hex
  account_id             TEXT NOT NULL DEFAULT 'default',
  sandbox_id             TEXT NOT NULL,
  status                 TEXT NOT NULL,                  -- pending|processing|blocked|completed
  blocked_reason         TEXT,
  error                  TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  completed_at           TEXT
);

CREATE INDEX idx_deletion_ops_status ON deletion_operations (status);

CREATE TABLE snapshots (
  id                     TEXT PRIMARY KEY,               -- orisnap_ + 32 hex
  account_id             TEXT NOT NULL DEFAULT 'default',
  sandbox_id             TEXT NOT NULL,
  name                   TEXT,
  provider_snapshot      TEXT NOT NULL,
  state                  TEXT NOT NULL,                  -- creating|complete|failed|deleting
  is_incremental         INTEGER NOT NULL DEFAULT 0,
  parent_id              TEXT,
  created_at             TEXT NOT NULL,
  completed_at           TEXT,
  UNIQUE (sandbox_id, name)
);

CREATE INDEX idx_snapshots_sandbox ON snapshots (sandbox_id);

CREATE TABLE named_snapshots (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL DEFAULT 'default',
  name                   TEXT NOT NULL,
  snapshot_id            TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  UNIQUE (account_id, name)
);

CREATE TABLE environments (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL DEFAULT 'default',
  name                   TEXT NOT NULL,
  is_default             INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (account_id, name)
);

CREATE TABLE environment_versions (
  id                     TEXT PRIMARY KEY,
  environment_id         TEXT NOT NULL,
  version                INTEGER NOT NULL,
  created_at             TEXT NOT NULL,
  UNIQUE (environment_id, version)
);

CREATE TABLE environment_vars (
  id                     TEXT PRIMARY KEY,
  version_id             TEXT NOT NULL,
  key                    TEXT NOT NULL,
  value                  TEXT NOT NULL,
  is_secret              INTEGER NOT NULL DEFAULT 0,
  UNIQUE (version_id, key)
);

CREATE TABLE environment_files (
  id                     TEXT PRIMARY KEY,
  version_id             TEXT NOT NULL,
  path                   TEXT NOT NULL,
  content                TEXT NOT NULL,
  is_secret              INTEGER NOT NULL DEFAULT 0,
  UNIQUE (version_id, path)
);

CREATE TABLE webhooks (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL DEFAULT 'default',
  url                    TEXT NOT NULL,
  secret_hash            TEXT NOT NULL,
  events                 TEXT NOT NULL,                  -- comma list: ready,error,archived
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (account_id, url)
);

CREATE TABLE pool_slots (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL DEFAULT 'default',
  pool_key               TEXT NOT NULL,                  -- provider|machine_type|env_version
  provider_handle        TEXT NOT NULL,
  state                  TEXT NOT NULL,                  -- available|claimed|releasing
  claimed_by             TEXT,
  claimed_at             TEXT,
  created_at             TEXT NOT NULL,
  UNIQUE (pool_key, provider_handle)
);

CREATE TABLE vmid_allocations (
  vmid                   INTEGER PRIMARY KEY,
  provider               TEXT NOT NULL,
  account_id             TEXT NOT NULL DEFAULT 'default',
  sandbox_id             TEXT,
  created_at             TEXT NOT NULL,
  released_at            TEXT
);

CREATE TABLE processes (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL DEFAULT 'default',
  sandbox_id             TEXT NOT NULL,
  status                 TEXT NOT NULL,                  -- running|completed|failed|killed
  exit_code              INTEGER,
  cmd                    TEXT NOT NULL,
  stdout                 TEXT,
  stderr                 TEXT,
  started_at             TEXT NOT NULL,
  completed_at           TEXT
);