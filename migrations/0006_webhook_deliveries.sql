-- C22 — account surface (plans/C22-account.md).
--
-- Webhooks (0001 already reserves the table) need the pieces that make
-- deliveries real:
--
--   * `secret` — the HMAC signing key. Stored raw, deliberately NOT hashed:
--     HMAC verification is symmetric, so the control plane must be able to
--     sign with the exact secret the receiver was shown at creation. It never
--     leaves via the API except at create/rotate (shown once, like an api key).
--   * `prefix` / `last_four` — how `webhook list` identifies a webhook after
--     the secret is gone, mirroring api_keys.
--
-- `webhook_deliveries` holds one row per lifecycle event per subscribed
-- webhook. Enqueueing is a fast INSERT on the request path; the HTTP delivery
-- and its retries run on a background task, so a slow receiver never delays a
-- sandbox reaching `ready`. Retries use exponential backoff and are capped at
-- `max_attempts` — a dead endpoint is marked `dropped` (with `dropped_at` and
-- `last_error`) rather than accumulating pending deliveries without bound.

ALTER TABLE webhooks ADD COLUMN prefix TEXT NOT NULL DEFAULT '';
ALTER TABLE webhooks ADD COLUMN last_four TEXT NOT NULL DEFAULT '';
ALTER TABLE webhooks ADD COLUMN secret TEXT NOT NULL DEFAULT '';

CREATE TABLE webhook_deliveries (
  id               TEXT PRIMARY KEY,          -- oriwd_ + 32 hex
  webhook_id       TEXT NOT NULL,
  event            TEXT NOT NULL,             -- ready|error|archived
  payload          TEXT NOT NULL,             -- JSON body POSTed to the endpoint
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|delivered|dropped
  next_attempt_at  TEXT,                      -- rfc3339; null means due now
  last_error       TEXT,
  delivered_at     TEXT,
  dropped_at       TEXT,
  created_at       TEXT NOT NULL,
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

CREATE INDEX idx_webhook_deliveries_due
  ON webhook_deliveries (status, next_attempt_at);

-- Account-wide settings. `data_retention_enabled` turns on delete-on-stop:
-- sandbox data is destroyed on stop instead of snapshotted. Irreversible and
-- destructive — the CLI requires explicit confirmation before enabling.
CREATE TABLE account_settings (
  account_id              TEXT PRIMARY KEY,
  data_retention_enabled  INTEGER NOT NULL DEFAULT 0,
  updated_at              TEXT NOT NULL
);