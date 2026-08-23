# C23 — collapse the duplicated wire types

**Owns the seam:** one definition of the wire contract.

Run this **last**. It touches every crate, so it must not land while feature work
is in flight.

## The debt

| file | lines |
|---|---|
| `crates/ori-server/src/proto.rs` | ~880 |
| `crates/ori-cli/src/wire.rs` | ~320 |
| `crates/ori-proto/src/lib.rs` | **placeholder** |

Two independent `Provider` traits also exist —
`crates/ori-providers/src/reconcile.rs` and `crates/ori-server/src/proto.rs` —
bridged by an adapter that only exists because both do.

## Why this is worth doing

It is not tidiness. The duplication **already caused an outage**: the server
emitted `memoryGb`, the client required `memoryGB`, and `ori list` broke
outright. Both sides round-tripped their own copy perfectly, so no test on
either side could catch it. Collapsing the definition makes that class of bug
*unrepresentable* rather than merely tested-for.

## Do it as a deletion

Promote the more complete definition into `ori-proto`; delete the copies; have
server, client and providers import it. ~1,200 lines become ~880. Do not
"align" the two copies — that preserves the failure mode.

Guard rails while promoting:

- `ori-proto` stays **I/O-free and dependency-light**. The server's copy may
  carry `sqlx` derives; those must not follow it in, or `ori-agent` inherits a
  database driver it has no use for. Check with `cargo tree`.
- Collapse the two `Provider` traits to one, in `ori-proto`. If the adapter
  becomes a pure pass-through afterwards, **delete the adapter too** — an
  identity wrapper is indirection with no payer.
- `ori-agent` must not gain a dependency on `ori-providers`.

## Done means

`cargo build --workspace`, `cargo test --workspace`, and
`cargo clippy --workspace --all-targets -- -D warnings` all clean; `cargo tree`
showing no I/O or database crate under `ori-proto`; and a net **reduction** in
total lines. If the line count went up, the consolidation did not happen.
