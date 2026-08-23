-- Per-sandbox token authenticating that sandbox's agent tunnel.
--
-- Deliberately NOT the account API key: a token that ships inside a sandbox is
-- readable by anything running in that sandbox, so it must not be an account
-- credential. It authorises exactly one thing — this sandbox's tunnel.
ALTER TABLE sandboxes ADD COLUMN agent_token TEXT;

CREATE INDEX IF NOT EXISTS idx_sandboxes_agent_token
  ON sandboxes(agent_token) WHERE agent_token IS NOT NULL;
