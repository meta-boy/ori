# Divergences, gaps, and decisions

Living document. Honest list of what does not match the spec and why.

## Decision: `ori-proto` is derived, not authored

The plan had `ori-proto` authored first as the single source of truth, with the
other crates importing from it. In practice the agent assigned to it produced
nothing in the time three other crates took to write ~4,300 lines, each
defining its own local copy of the wire types (9 `TODO(reconcile)` markers,
plus `ori-server/src/proto.rs` at 830 lines and `ori-cli/src/wire.rs` at 307).

Rather than author a **fourth** definition and reconcile four ways, the most
complete existing implementation is promoted into `ori-proto` and the other
crates are rewired to import it. This is a deletion, not an addition: three
copies collapse to one.

Consequence to watch: the promoted types were written to serve one crate's
needs, so they may carry server-shaped assumptions (e.g. types that should be
I/O-free carrying `sqlx` derives). The integration pass (`plans/C11`) must
check that `ori-proto` stays dependency-light and I/O-free, and that
`ori-agent` does not transitively depend on `ori-providers`.

## Open: fork latency is 7× over target

Measured fork total is **51–52 s** against a ≤7 s target. Cause is not the
snapshot (1.44 s) but the linked clone from it (**44.9 s**). See
`docs/BENCHMARKS.md`; a clone from a snapshot of a *stopped* container is
1.7 s, so the penalty is specific to snapshots taken while running.
Investigation in progress. Until resolved, `fork` does not meet its target and
saying otherwise would be false.

## Corrected: the earlier "rollback poisons the thin pool" claim

An earlier reading attributed a ~45 s clone penalty to `pct rollback`. That was
wrong. The same ~45 s appears with no rollback anywhere in the sequence. The
actual common factor is cloning from a snapshot taken while the container was
running. `rollback` is still slow in its own right (~47 s to become executable)
and still should not sit on a request path, but it is not the cause of the
clone penalty.
