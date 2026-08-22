# C1 — workspace + `ori-proto` (foundation, no I/O)

**You own:** `Cargo.toml` (workspace root), `rust-toolchain.toml`, `.gitignore`,
`crates/ori-proto/**`. Nothing else. Do not create the other crates' source.

Read first: `docs/SPEC-API.md`, `docs/ARCHITECTURE.md`, `docs/SPEC-CLI.md`.

## Deliver

1. **Workspace root `Cargo.toml`** declaring ALL five members up front so the
   other agents can drop their crate in without touching this file:
   `crates/ori-proto`, `crates/ori-providers`, `crates/ori-server`,
   `crates/ori-agent`, `crates/ori-cli`. Shared `[workspace.dependencies]`
   (serde, serde_json, thiserror, chrono, tokio, async-trait, uuid, tracing).
   Edition 2021, resolver 2.

2. **Domain types** — `BoxId`, `SnapshotId`, `DeletionOpId`, `ApiKeyId`.
   Newtypes over `String` with parsing + `Display`. Formats in `SPEC-API.md`:
   `ori_` + 8 `[a-z0-9]`, `oriop_` + 32 hex. Generation must use a CSPRNG, not a
   `rand` thread seed derived from time.

3. **Three-word slug generator** for `subdomain`. Ship a wordlist (>=256 words
   per position is enough for the collision math to be fine at our scale); the
   caller retries on a uniqueness violation, so do not pretend it is collision-free.

4. **`BoxState` enum** covering exactly the states in `SPEC-API.md`
   (`init`, `provisioning`, `cloning`, `provisioned`, `ready`, `running`, `idle`,
   `stopping`, `stopped`, `archiving`, `archived`, `error`) with:
   - serde rename to the exact lowercase wire strings
   - `fn group(&self) -> StateGroup` for the `r/s/p/t/e` filter letters
   - `fn can_transition_to(&self, next) -> bool` encoding the transition table.
     A rejected transition is an error the server surfaces, not a silent no-op.

5. **Wire DTOs** — every request and response in `SPEC-API.md`, including the
   `{"sandbox": {...}}` wrapper on info (it is load-bearing: the real client parses it).
   `#[serde(rename_all = "camelCase")]`, `Option<T>` where the spec says nullable,
   `skip_serializing_if` nowhere the real client expects a key present-and-null.

6. **NDJSON event enum** — `Event::{Created, State, Accepted, Ready, Error}`,
   `#[serde(tag = "event", rename_all = "camelCase")]`, serialising to exactly
   the lines quoted in `SPEC-API.md`.

7. **`MachineType`** — `small|default|large` ↔ (vcpu, memoryGB, billingMultiplier)
   per the table. One source of truth; the server must not restate these numbers.

8. **The `Provider` trait + `Capabilities` + `InstanceSpec` / `InstanceHandle` /
   `SnapshotRef` / `ExecRequest` / `ExecResult` / `StopMode` / `InstanceStatus`**
   exactly as sketched in `ARCHITECTURE.md`. `async_trait`. No provider-specific
   types leak through it. Document the idempotency contract on each method.

9. **Error taxonomy** — `thiserror`, and a mapping to the HTTP status + JSON error
   body the real client tolerates. Distinguish: not-found, conflict (409, e.g.
   snapshot has dependents), quota/rate-limited (429), provider-unavailable (503),
   invalid-transition (409).

## Done means

`cargo test -p ori-proto` passes with tests that actually assert the wire format:
serialise each event and DTO and compare against the literal JSON strings from
`SPEC-API.md`. Round-trip tests alone do not prove wire compatibility — a
consistently wrong field name round-trips fine. Include a rejected-transition test
and an ID-format test.

Keep it dependency-light and I/O-free: no `reqwest`, no `axum`, no filesystem.
