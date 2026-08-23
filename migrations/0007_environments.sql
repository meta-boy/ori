-- C19: environments. The `environments`, `environment_versions`,
-- `environment_vars` and `environment_files` tables already exist (0001);
-- this adds the two pieces of a versioned bundle the base schema had no
-- columns for: repo checkouts and safety toggles.
--
-- Repos are part of a version's bundle, so they are keyed by version_id like
-- vars and files. Toggles are stored as JSON on the version row itself: a
-- version is immutable, so the toggles that minted it travel with it.

CREATE TABLE environment_repos (
  id          TEXT PRIMARY KEY,
  version_id  TEXT NOT NULL,
  url         TEXT NOT NULL,
  branch      TEXT,
  path        TEXT NOT NULL,
  UNIQUE (version_id, url)
);

ALTER TABLE environment_versions ADD COLUMN toggles TEXT NOT NULL DEFAULT '{}';