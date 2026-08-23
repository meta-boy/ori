-- `ori prompt` / `interrupt` / `events`: a coding agent run inside a sandbox.
--
-- A run is a detached process in the sandbox plus an append-only event log, so
-- `events` can be replayed after the fact and followed while live. The prompt
-- text is stored because a run is not reconstructible without it, but it is
-- never written to a log line.
CREATE TABLE IF NOT EXISTS agent_runs (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  sandbox_id   TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model        TEXT,
  effort       TEXT,
  prompt       TEXT NOT NULL,
  -- running | completed | failed | interrupted
  status       TEXT NOT NULL,
  pid          INTEGER,
  exit_code    INTEGER,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_sandbox ON agent_runs(sandbox_id, started_at);

-- Append-only. `seq` orders events within a run so a follower can resume from
-- the last one it saw rather than re-reading the whole log.
CREATE TABLE IF NOT EXISTS agent_events (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(run_id, seq);
