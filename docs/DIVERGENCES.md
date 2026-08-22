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

Status as of the C11 integration pass (2026-08-23): all six are fixed and
verified by running the binaries. Bug 1's fix was partly in place before this
pass (routes moved, regression test added); bugs 3/4/5/6 are resolved by this
pass. Details and the remaining seams are in "Integration pass (C11)" below.

### 1. Cold start is impossible — no way to mint the first API key — FIXED
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
exercises it. (`tests/server.rs::bootstrap_mints_first_key_and_it_authenticates`.)

### 2. `ori list` cannot decode the server's response — FIXED
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

Fix: the server field now carries `#[serde(rename = "memoryGB")]` explicitly,
overriding the struct-level `rename_all`. Verified by `ori list` against a live
server and by the `create_honours_machine_type_and_ttl` test.

### 3. NDJSON reports `ready`, but the row ends up `error` — FIXED
`ori new` streamed `created → provisioning → cloning → ready` and returned an
ip, url and slug. The stored row then read `state: "error"` seconds later, with
nothing logged. The success stream is therefore not trustworthy — something in
the post-ready path (reconcile loop or a provider status re-check) demotes the
sandbox without recording a reason.

Root cause (found while reproducing against the real binary): `provider_handle`
was stored as `handle.to_string()` — the combined `"provider:id"` display
string — but every caller reconstructs the handle as
`InstanceHandle { provider: row.provider, id: row.provider_handle }`. The
resulting `id` (`"mock:1"`) never matched the provider's registry key (`"1"`),
so `status()` reported the instance missing and the reconciler demoted the
sandbox to `error` on the next 30 s pass. `resume` failed the same way
("not found: mock:1"). This also silently destroyed every live mock instance as
an "orphan" on each reconcile.

Fix: store only the provider-scoped id in `provider_handle` (the provider name
has its own column), and compare registry keys directly in the orphan pass.
Every transition into `error` now logs a `tracing::warn!` with the sandbox and
the reason. Regression test:
`tests/server.rs::reconcile_does_not_demote_a_healthy_ready_sandbox`.

### 4. `exec` returns HTTP 404 — FIXED
`ori exec <id> echo hello` → `HTTP 404 404: Not Found`. Route/verb or path shape
mismatch between client and server. Verify against `docs/SPEC-API.md`.

Root cause: the route table used axum-0.8-style `{id}` path params, but this
workspace pins axum 0.7 / matchit 0.7, which use `:id`. `{id}` was a literal
segment, so `/sandboxes/abc/exec` never matched. All routes now use `:id`
(`crates/ori-server/src/routes/mod.rs`), verified by `ori exec` against a live
server (real exit codes propagate) and by the `exec_runs_and_reports_exit_codes`
test.

### 5. Two binaries, not one — FIXED
`cargo build --workspace` produces both `ori` and `ori-server`, and `ori serve`
in the client is a stub. `docs/ARCHITECTURE.md` specifies **one** binary with
three roles. Wire `ori serve` to the control plane and `ori agent` to the guest
agent, and stop shipping a second artifact.

Fix: `ori-server` is now library-only (no `[[bin]]`; `src/main.rs` deleted) and
`ori serve` in `ori-cli` parses `--bind/--db-path/--domain/--provider` and calls
`ori_server::run`. `ori agent` is Linux-gated and calls `ori_agent::run`.
`cargo build --workspace` ships exactly one binary, `ori`; `ori --help`,
`ori serve --help`, `ori agent --help` all work.

### 6. The Proxmox provider is never wired in — FIXED
`ori-server serve` exposes only `--bind`, `--db-path`, `--domain`. There is no
provider selection, so the server always runs `MockProvider`. The Proxmox
provider in `ori-providers` — which is implemented, compiles, polls UPIDs
correctly and handles the loopback-address trap — is unreachable from the
server. **Nothing has yet created a real container.** This is the single most
important gap: until it closes, the product is an API with a simulator behind it.

Fix: a `--provider proxmox|docker|mock` flag plus provider config (host, token,
node, storage, bridge, template) from `ORI_PVE_*` env, and a startup preflight
that fails loudly on a non-snapshot-capable storage. `ori serve --provider proxmox`
against the `.env.local` host now creates, stops, resumes, forks (linked clone)
and execs into **real LXC containers**. `--provider docker` fails with a clear
"not implemented in this build" error.

## Integration pass (C11): what changed and what is still open

### Provider wiring is an adapter, not a reconciliation

`ori-server` now depends on `ori-providers` and drives it through a new
`crates/ori-server/src/providers.rs` `ProxmoxAdapter` that implements the
server's `proto::Provider` trait by translating onto `ori_providers::reconcile`
at the boundary. The two crates still have **two definitions of the Provider
trait and its domain types** (the server's `proto.rs` and the provider's
`reconcile.rs`). Per `docs/DIVERGENCES.md` those were supposed to collapse into
`ori-proto`, which is still a placeholder. Rather than author the shared crate
and rewrite both sides in this pass, the adapter bridges them — wiring over
rewriting, as the other agent owns `crates/ori-providers/src/proxmox`. The
collapse into `ori-proto` remains the recommended next step.

### VMID allocation must consult the live node, not just the counter

The architecture's "allocate from our own SQLite counter, then confirm against
`/cluster/nextid`" is not sufficient: `nextid` (105 on the test host) says
nothing about hand-assigned ids (a prior run left an `ori` container at vmid
1000). The adapter's `allocate_vmid` therefore reads the node's existing VMID
list (`GET /nodes/{n}/lxc`) each allocation, skips taken ids (burning them in
`vmid_allocations` so they are never retried), and stays out of the 9000-9099
test range. The provider's own `ensure_vmid_free` (`vmid < nextid`) remains as
a second line of defence against PVE auto-allocation.

### Fork must start the clone

The Proxmox `clone_from` returns a clone that is left **stopped** (that is the
contract in `docs/ARCHITECTURE.md`). The server's fork path never started it,
so a forked sandbox reported `ready` with `ip: null` and was demoted to
`error` on the next reconcile. `run_fork` now calls `start()` after
`clone_from`, before announcing ready. The mock never showed this because its
`clone_from` registers a running instance.

### `provider_handle` semantics are now "provider-scoped id only"

`InstanceHandle::Display` is still `provider:id` (used in logs), but
`provider_handle` in SQLite stores just the id, matching how every caller
reconstructs the handle (`provider` comes from its own column). Anything that
writes `handle.to_string()` into `provider_handle` is a bug.

### Open items (not fixed here, recorded honestly)

- **`ori serve --config <toml>`** — the systemd unit
  (`infra/systemd/ori-serve.service`) runs `ori serve --config /etc/ori/serve.toml`,
  but serve config is env-only in this build. The flag is not accepted; a TOML
  loader is a small follow-up.
- **`scripts/golden-build.sh`** looks for a separate `target/release/ori-agent`
  artifact, which no longer exists (one binary now). It should bake the `ori`
  binary and invoke `ori agent --config ...`; left to the ops owner.
- **`ori-agent` is a placeholder.** `ori agent` runs and exits with an honest
  "not landed yet" message; the real guest agent (exec / port-host / file ops)
  is C6's deliverable. The wiring (Linux-gated entrypoint, no `ori-providers`
  dependency) is in place.
- **The pre-existing clippy issues in `ori-server`** (`proto.rs` `&BASE36`,
  `ndjson.rs` `match`-on-`Option`, `insert_with_slug` argument count) predate
  this pass and are left alone rather than refactored mid-integration.
- **Self-signed PVE certs** require `ORI_PVE_INSECURE=1` (or a CA via
  `ORI_PVE_CA_PEM`); the `.env.local` host presents a self-signed cert, so a
  bare `ORI_PVE_*` environment fails preflight with a TLS error until that is
  set. The provider logs loudly when insecure mode is on.

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
