# C20 — snapshot management

**Owns the seam:** the snapshots `stop`/`fork` already create, exposed to the
user.

Snapshots are the substrate of `stop`, `resume` and `fork` — all working — and
none of it is reachable. `snapshots`, `snapshot`, `snapshot latest|tree|pull|rm`
are stubs.

## Commands

- `ori snapshots [id]` — list, one sandbox or all (`--limit`, `--all`, paginated).
- `ori snapshot <id> <name>` — save under a name; reusing a name replaces it.
- `ori snapshot latest <id>` · `tree <snap>` · `pull <snap>` (download and
  reassemble locally) · `delete <snap>` · `rm <name>`.

## The parts that will bite

- **Surface `takenWhileStopped`.** `docs/BENCHMARKS.md` establishes that a
  snapshot taken while the container was running is permanently ~20x more
  expensive to clone from. That is now a column on the row; show it, because it
  is the difference between a fork that takes 9 s and one that takes 51 s. A
  snapshot list that hides it is hiding the only field that predicts cost.
- **`delete` must refuse a snapshot with dependents** — 409, with the operation
  recording *why*. Deleting a snapshot another one is layered on is data loss,
  not an error to paper over.
- **`pull` streams.** Do not buffer a multi-GB snapshot in memory. The `File`
  stream frame in `crates/ori-agent` already handles chunked transfer with
  backpressure; reuse it rather than inventing a second path.
- Named snapshots are capped (10 per account in the spec) — enforce it, and say
  which one to remove when the cap is hit.

## Done means

Real CLI against a real host: take a named snapshot, list it, see its
`takenWhileStopped` value, `pull` it and verify the reassembled bytes, then
prove a dependent snapshot's delete is refused with a reason.
