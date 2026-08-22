# C3 — `ori-server`: control plane

**You own:** `crates/ori-server/**`, `migrations/**`. Not the workspace Cargo.toml.

Read: `docs/SPEC-API.md` (the contract), `docs/ARCHITECTURE.md`,
`docs/BENCHMARKS.md`.

`axum` + `tokio` + `sqlx` (SQLite, WAL). Binary role `ori serve`.

## The acceptance test that defines this crate

**The real `sandbox` binary, run with `ORI_API_URL=http://localhost:PORT`, must
work unmodified.** That is the definition of done, and it is a much harsher
oracle than any test you write yourself. `ori list`, `ori new`, `ori info`,
`ori stop`, `ori resume`, `ori fork`, `ori exec`, `ori status`, `ori limits`
must all behave. Wire up the endpoints so that is achievable and leave notes on
whatever cannot be satisfied.

## Deliver

1. **Every endpoint in `SPEC-API.md`.** Exact paths, exact response shapes,
   including the `{"sandbox": {...}}` wrapper on info.

2. **NDJSON streaming for `create` / `resume` / `fork`.** One JSON object per
   line, flushed immediately — a buffered response that arrives all at once
   makes the real client sit silent for the whole operation and is a bug even
   though the bytes are identical. Errors are a terminal event on the stream,
   not a mid-stream status change (the status is long gone by then).

3. **SQLite schema + migrations**: sandboxes, snapshots, named_snapshots,
   environments, environment_versions, environment_vars, environment_files,
   api_keys, webhooks, pool_slots, vmid_allocations, deletion_operations,
   processes. Every table that hands out a shared resource gets a uniqueness
   constraint — the VMID allocator and the pool claim both depend on the
   database refusing a double-issue rather than on application-level checks.

4. **Auth, both modes.** Bearer API key (hash at rest — argon2 or scrypt, never
   plaintext or a bare SHA), and device-code login
   (`/cli/login/start` + `/cli/login/poll/{id}`). Keys show prefix + last four
   after creation and the secret exactly once.

5. **State machine enforcement** via `ori_proto::BoxState::can_transition_to`.
   A `stop` on an already-stopping sandbox is idempotent; a `resume` on a running
   sandbox is a 409, not a second provisioning run.

6. **TTL reaper.** `archiveAfter` reached → `stop`. Runs on a timer, takes a
   row lock, and must survive a restart mid-reap without double-stopping.
   `--no-auto-stop` means no deadline; `extend` moves it.

7. **Deletion operations.** `DELETE` returns `oriop_<hex32>` immediately and the
   real work happens async, with status `pending|processing|blocked|completed`.
   `blocked` is a real state: a snapshot with dependent incrementals cannot be
   deleted (409), and the operation records why.

8. **Environments + versions.** `env set*` mints a new version; running sandboxes
   stay pinned until `env upgrade`. Secret files and vars are per-version and
   immutable once minted. `--no-env` sandboxes get nothing from the account and stay
   that way across resume — one-way, per the CLI's own wording.

9. **Reconciliation loop**, every 30 s and at startup. The provider is truth for
   existence, the DB is truth for intent. A container the provider has and we do
   not is an orphan to destroy; a sandbox we call `ready` that the provider says is
   stopped becomes `error`. Without this the DB drifts and the pool hands out
   containers that do not exist.

10. **Webhooks** — `ready|error|archived`, HMAC-signed with a per-webhook
    secret, retried with backoff, with the signing secret shown once.

11. **Reverse proxy for `host`** — subdomain-keyed, token-gated by default,
    `--public` opt-in.

## Explicitly out of scope for v1

`prompt` / `interrupt` / `events` (vendor AI agents inside the sandbox):
implement the endpoints and the event-stream shape, return a clear
"not implemented in this build" error, and do not fake agent output. Teams:
model the field, return a single personal scope.

## Done means

- `cargo test -p ori-server` — integration tests against a `MockProvider`
  (in-memory `Provider` impl) covering each endpoint's wire shape, the NDJSON
  line format, invalid transitions, TTL reaping, and auth rejection.
- One test asserting the NDJSON is actually flushed per line, not buffered.
- No secret ever appears in a log line, including at `debug`.
