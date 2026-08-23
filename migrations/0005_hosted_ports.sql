-- Ports exposed on a stable URL by `ori host`.
--
-- `token` gates a private URL. It is per (sandbox, port) rather than per
-- account: handing someone a preview link must not hand them the account.
CREATE TABLE IF NOT EXISTS hosted_ports (
  id          TEXT PRIMARY KEY,
  sandbox_id  TEXT NOT NULL,
  port        INTEGER NOT NULL,
  public      INTEGER NOT NULL DEFAULT 0,
  token       TEXT,
  title       TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (sandbox_id, port)
);

CREATE INDEX IF NOT EXISTS idx_hosted_ports_sandbox ON hosted_ports(sandbox_id);
