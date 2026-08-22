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

## Verified integration bugs (found by running the binaries, 2026-08-23)

Each was reproduced against a live `ori-server` with the real `ori` client.
Ordered by severity. This list is the input to `plans/C11-integration.md`.

### 1. Cold start is impossible — no way to mint the first API key
`POST /api/v1/api-keys` is registered inside the `protected` router in
`crates/ori-server/src/routes/mod.rs`, which carries
`.layer(...auth::require_auth)`. The handler in `routes/account.rs` contains
first-key bootstrap logic ("no keys yet -> unauthenticated mint"), and its own
doc comment claims the route "lives outside the auth middleware" — but it does
not, so that logic is unreachable. Every request returns
`{"error":{"code":"unauthorized"}}`.

The device-login path is not an escape hatch: `/cli/login/start` works
unauthenticated, but `/cli/login/{id}/approve` and `/cli/login/poll/{id}` both
return 401, so a token can never be obtained either. **A freshly deployed
server cannot be used at all.** Testing had to insert an argon2 key row
directly into SQLite to proceed.

Fix: move key creation (and the login approve/poll pair) out of the protected
router, keeping the handler's own bearer check for the non-bootstrap case.
Add a test that a brand-new database can mint a first key and then authenticate
with it — the cold-start path needs a regression test, since nothing else
exercises it.

### 2. `ori list` cannot decode the server's response
- CLI `crates/ori-cli/src/wire.rs:38` — `#[serde(rename = "memoryGB")]`
- Server `crates/ori-server/src/proto.rs:369` — `rename_all = "camelCase"`
  emits `memoryGb`

One letter. The client field is not `Option`, so decoding fails outright and
`ori list` reports `bad_response: error decoding response body`. `docs/SPEC-API.md`
specifies `memoryGB`, so the server is wrong.

This is the exact failure mode the shared `ori-proto` crate exists to prevent,
and the reason `plans/C8` requires asserting field names against the spec
rather than round-tripping through our own types: both sides round-trip
perfectly and still disagree.

### 3. NDJSON reports `ready`, but the row ends up `error`
`ori new` streamed `created → provisioning → cloning → ready` and returned an
ip, url and slug. The stored row then read `state: "error"` seconds later, with
nothing logged. The success stream is therefore not trustworthy — something in
the post-ready path (reconcile loop or a provider status re-check) demotes the
sandbox without recording a reason.

Whatever the cause, two things are wrong independently: the state changed with
no diagnostic written, and a terminal `error` state carries no operator-visible
explanation. Fix the demotion, and make any transition into `error` record why.

### 4. `exec` returns HTTP 404
`ori exec <id> echo hello` → `HTTP 404 404: Not Found`. Route/verb or path shape
mismatch between client and server. Verify against `docs/SPEC-API.md`.

### 5. Two binaries, not one
`cargo build --workspace` produces both `ori` and `ori-server`, and `ori serve`
in the client is a stub. `docs/ARCHITECTURE.md` specifies **one** binary with
three roles. Wire `ori serve` to the control plane and `ori agent` to the guest
agent, and stop shipping a second artifact.

### 6. The Proxmox provider is never wired in
`ori-server serve` exposes only `--bind`, `--db-path`, `--domain`. There is no
provider selection, so the server always runs `MockProvider`. The Proxmox
provider in `ori-providers` — which is implemented, compiles, polls UPIDs
correctly and handles the loopback-address trap — is unreachable from the
server. **Nothing has yet created a real container.** This is the single most
important gap: until it closes, the product is an API with a simulator behind it.

Fix: a `--provider proxmox|docker|mock` flag plus provider config (host, token,
node, storage, bridge, template) from env, and a startup preflight that fails
loudly on a non-snapshot-capable storage.

### 7. Two `Provider` traits — the adapter cannot call the provider

Diagnosed while C11 was wiring Proxmox into the server:

- `crates/ori-providers/src/reconcile.rs:194` — `pub trait Provider`
- `crates/ori-server/src/proto.rs:748` — `pub trait Provider`

`ProxmoxProvider` implements the **ori-providers** one
(`proxmox/mod.rs:517`). The adapter in `ori-server/src/providers.rs` calls
`capabilities`/`create`/`start`/`stop` expecting the **server's** trait, so the
compiler reports "no method named `create` found for struct `ProxmoxProvider`".
Compounding it, `ori-providers/src/lib.rs` re-exports only `reconcile::Error`,
never the trait, so the trait is not even nameable from outside the crate and
cannot be brought into scope.

Minimal unblock: `pub use reconcile::Provider;` from `ori-providers`, then
`use ori_providers::Provider as _;` at the adapter call site.

Correct fix, and the one worth doing: **the trait belongs in `ori-proto`,
defined once.** Both of these traits exist only because `ori-proto` was empty
when each crate needed one. This is the same root cause as bug 2
(`memoryGb`/`memoryGB`) — a shared contract that was specified in prose and then
implemented twice. Collapsing it removes an entire class of failure instead of
fixing two instances of it.
