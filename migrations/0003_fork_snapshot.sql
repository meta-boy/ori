-- C12 — fork clones from a stopped-taken snapshot (plans/C12-fork-fix.md).
--
-- A snapshot taken while the container was running is permanently ~20x more
-- expensive to clone from (docs/BENCHMARKS.md §Root cause): measured 44.9 s
-- vs 2.6 s, and the penalty is a property of the snapshot, not the source's
-- later state. `fork` must therefore clone from a snapshot taken while the
-- source was stopped. This column records that fact per snapshot.
--
-- Backfilled 0 (pessimistic): a mislabelled running snapshot silently costs
-- ~45 s per fork, while a mislabelled stopped snapshot costs nothing.

ALTER TABLE snapshots ADD COLUMN taken_while_stopped INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_snapshots_stopped ON snapshots (sandbox_id, taken_while_stopped, state);