# Code quality review

Strict maintainability pass. Bias: delete moving pieces rather than rearrange
them. Correctness bugs live in `docs/DIVERGENCES.md`; this file is structure.

## 1. The shared-types crate is a 10-line placeholder while 1,199 lines of
## near-duplicate DTOs live in two crates

| file | lines |
|---|---|
| `crates/ori-server/src/proto.rs` | 880 |
| `crates/ori-cli/src/wire.rs` | 319 |
| `crates/ori-proto/src/lib.rs` | **10** (placeholder) |

Plus 12 `TODO(reconcile)` markers.

This is not a stylistic complaint — **the duplication already caused a
production failure.** The server emitted `memoryGb`, the client demanded
`memoryGB`, and `ori list` broke outright. Two agents, one written spec, one
letter of divergence, and no test on either side could catch it because each
round-trips perfectly through its own copy.

The fix is a deletion, not a refactor: promote the more complete definition into
`ori-proto`, delete both copies, have server and client import it. Then the
class of bug becomes unrepresentable rather than merely tested-for. This is the
single highest-value change in the codebase and it makes ~1,200 lines into ~880.

Watch when promoting: `ori-proto` must stay I/O-free and dependency-light. The
server's copy may carry `sqlx` derives that must not follow it in, or
`ori-agent` inherits a database driver it has no use for.

## 2. Panic risk: 54 `unwrap()`/`expect()` calls in non-test code

Spread across `ori-server/src`, `ori-providers/src`, `ori-cli/src`. In a control
plane, an `unwrap` on a parse or a network result is a crash that takes every
in-flight sandbox operation with it. Audit each: most should be `?` with a
typed error; the few that encode a real invariant should say so in an
`expect("...")` message that names the invariant.

## 3. File sizes are healthy — no waivers needed

Largest is `ori-server/tests/server.rs` at 901 lines (a test file, acceptable),
then `proto.rs` at 880 and `routes/sandboxes.rs` at 755. Nothing over the 1,000
line ceiling. `routes/sandboxes.rs` is the one to watch: it holds create, list,
get, delete, stop, resume, fork, extend and exec, and the NDJSON streaming
paths. If it grows further, split by lifecycle-vs-query rather than
one-file-per-route.

## 4. Clippy: 14 warnings, all mechanical

7 needless borrows, 2 manual `Option::map`, a `contains()` that should be
`iter().any()`, a collapsible `if`, and one function with 10 arguments. 11 are
auto-fixable with `clippy --fix`. The 10-argument function is the only real
signal: that many parameters usually means a struct is missing.

Worth enforcing `-D warnings` in CI now rather than later — five crates written
in parallel by different agents will keep drifting otherwise, and this is the
only mechanism that holds the line.

## 5. Structural observation: two binaries where the design says one

`cargo build --workspace` yields `ori` and `ori-server`; `ori serve` in the
client is a stub. Beyond the packaging goal, this is a correctness hazard: two
artifacts can be built from different commits and disagree about the wire
format — the same failure as item 1, but across a version skew instead of
across crates. One binary removes the possibility.

## What is genuinely good

- `ori-providers/src/proxmox/client.rs` routes every mutation through a UPID
  poller that requires `exitstatus == "OK"`, and documents that HTTP 200 means
  "queued". This was the top correctness risk in the whole system and it is
  handled properly.
- Address discovery filters loopback before accepting an IP, with a deadline —
  the trap that would otherwise hand out `127.0.0.1` as a sandbox address.
- `scripts/preflight.sh` proves capabilities with a real create/snapshot/clone/
  destroy round trip and cleans up on failure, instead of trusting permission
  bits. 19 checks, machine-readable output.
- The CLI's exit-code contract (0 / 1 / 2 / remote code) is implemented and
  covered by process-level tests, not just unit tests.
