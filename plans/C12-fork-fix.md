# C12 — `fork` must not snapshot a running source

**Owns the seam:** `ori fork` end-to-end, from CLI call to a working child, for
**both** a stopped and a running source. Not "the fork handler" — the behaviour.

## The bug

`fork` takes a fresh snapshot of the source. When the source is running, that
snapshot is permanently ~20× more expensive to clone from
(`docs/BENCHMARKS.md` §Root cause). Measured minutes apart, same binary:

| sequence | source at fork | fork |
|---|---|---|
| `new → exec → stop → fork` | stopped | **8.68 s** |
| `new → exec → stop → resume → fork` | running | **50.76 s** |

The rule was derived correctly and is currently honoured only by accident — when
the source happens to be stopped and `stop`'s snapshot is the latest one.

## What to build

`fork` clones from the newest **stopped-taken** snapshot. Concretely:

1. Track, per snapshot, whether the source was stopped when it was taken. The
   `snapshots` table needs this (a `taken_while_stopped` column, backfilled
   false — pessimistic is correct, a mislabelled running snapshot silently costs
   45 s).
2. `fork` selects the newest snapshot with that flag set and clones from it.
3. If none exists, do **not** silently snapshot a running source. Either
   stop → snapshot → start the source (~10 s, brief source downtime) or refuse
   with a message naming the cost. Pick one, implement it, and say which in the
   NDJSON stream.
4. **The semantic cost must be visible.** Forking from an older snapshot means
   writes since that snapshot are not in the child. Say so in `ori fork`'s
   output — a fork that silently omits recent work is worse than a slow fork.

## Done means

A test — against the real host, not a mock — that forks a **running** sandbox and
completes well under 15 s, plus the existing stopped-source path still ~9 s.
Both must assert the child inherited data and the parent was unaffected.
Record both numbers in `docs/BENCHMARKS.md`, replacing the correction section.
