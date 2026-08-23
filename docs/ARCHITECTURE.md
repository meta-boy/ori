# Architecture

One binary. Three roles. Five crates. Providers behind cargo features.

## Deliverable shape

A single cross-platform Rust binary, `ori`, that is the client, the server, and
the guest agent depending on how it is invoked:

```
ori <command>          # client   — macOS/Linux, arm64/x64
ori serve              # control plane (the backend deliverable)
ori agent              # guest agent, runs inside each sandbox (linux only)
```

Why one binary: the guest agent must be pushed into every sandbox, the CLI must
be `curl | sh`-installable, and the server is self-hosted. Three separate
artifacts means three release pipelines and three version-skew bugs. One binary,
cross-compiled per target, `ori agent` gated to `#[cfg(target_os = "linux")]`.

## Crates

```
crates/
  ori-proto      wire DTOs, NDJSON event enum, domain types, ID gen, state machine,
                the Provider trait. NO I/O, NO tokio runtime, no provider deps.
  ori-providers  every backend behind a feature: proxmox (default), docker,
                firecracker, apple-container. One trait impl per module.
  ori-server     axum control plane, SQLite state, pool manager, snapshot store,
                auth, webhooks, TTL reaper.
  ori-agent      guest-side exec / port-host / file ops.
  ori-cli        clap surface + human and --json rendering.
```

Five, not nine. Providers are feature-gated modules in one crate rather than a
crate each — a Proxmox HTTP client has no business being a compile-time
dependency of the guest agent, and feature flags solve that without a crate
explosion. Split a provider out only when one grows its own native deps
(Firecracker will, eventually; it can move then).

`ori-proto` holds the Provider trait because both the server (caller) and the
providers (implementors) need it and neither should depend on the other.

## The Provider trait

The abstraction has to be honest about what backends cannot do, or the server
will confidently call `suspend` on something that has no CRIU and report a
success that never happened. Capabilities are declared, and the server degrades.

```rust
pub struct Capabilities {
    pub linked_clone: bool,      // O(1) clone from a snapshot
    pub fs_snapshot: bool,       // filesystem snapshot while running
    pub live_suspend: bool,      // memory-state suspend/resume (CRIU, VM pause)
    pub resize_online: bool,
    pub desktop: bool,
    pub nested_containers: bool, // docker-in-sandbox
    pub max_instances: Option<u32>,
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities;

    async fn create(&self, spec: &InstanceSpec) -> Result<InstanceHandle>;
    async fn clone_from(&self, src: &SnapshotRef, spec: &InstanceSpec) -> Result<InstanceHandle>;
    async fn start(&self, h: &InstanceHandle) -> Result<()>;
    async fn stop(&self, h: &InstanceHandle, mode: StopMode) -> Result<()>;
    async fn destroy(&self, h: &InstanceHandle) -> Result<()>;
    async fn status(&self, h: &InstanceHandle) -> Result<InstanceStatus>;

    async fn snapshot(&self, h: &InstanceHandle, name: &str) -> Result<SnapshotRef>;
    async fn rollback(&self, h: &InstanceHandle, s: &SnapshotRef) -> Result<()>;
    async fn snapshot_delete(&self, s: &SnapshotRef) -> Result<()>;

    async fn exec(&self, h: &InstanceHandle, req: ExecRequest) -> Result<ExecResult>;
    async fn resize(&self, h: &InstanceHandle, t: MachineType) -> Result<()>;
    async fn addresses(&self, h: &InstanceHandle) -> Result<Addresses>;
}
```

Rules the trait must obey:

- Every method is idempotent or explicitly documented as not. `stop` on a
  stopped instance is `Ok`, not an error. The TTL reaper and the pool manager
  will both race on the same instance; make that boring.
- `rollback` is a management operation, never a request-path one. Measured: an
  LXC takes ~47 s to become executable after a rollback, stopped or running —
  LVM-thin drops and recreates the LV. The trait exposes it for
  environment/admin flows; `resume` and `fork` must not call it.
- `StopMode::{Snapshot, Force}` — `Force` skips the snapshot and is documented
  as data-losing, matching `ori stop --force`.
- No method returns provider-specific types. `InstanceHandle` is an opaque
  provider-scoped string plus the provider name, stored in SQLite.

## Proxmox provider

Backend is the Proxmox REST API (`/api2/json`), token auth
(`Authorization: PVEAPIToken=user@realm!tokenid=secret`), not SSH. SSH is a
fallback for `exec` only where the guest agent is not yet up.

Mapping:

| Operation | Proxmox call |
|---|---|
| `create` (cold) | `POST /nodes/{n}/lxc` from template, then start |
| `clone_from` | `POST /nodes/{n}/lxc/{vmid}/clone` with `full=0`, `snapname=` |
| `snapshot` | `POST /nodes/{n}/lxc/{vmid}/snapshot` |
| `rollback` | `POST .../snapshot/{name}/rollback` (stopped only) |
| `stop` | `POST .../status/stop` (after snapshot) |
| `start` | `POST .../status/start` |
| `destroy` | `DELETE /nodes/{n}/lxc/{vmid}` |
| `resize` | `PUT .../config` (cores, memory) |
| `exec` | guest agent over the control-plane tunnel; `pct exec` fallback |

Proxmox capabilities: `linked_clone: true`, `fs_snapshot: true`,
**`live_suspend: false`** (CRIU measured failing), `nested_containers: true`
(needs `features nesting=1`), `desktop: true` (via guest-side VNC).

Every mutating call returns a **UPID task id**. The provider must poll
`GET /nodes/{n}/tasks/{upid}/status` to completion — treating the 200 as
"done" is the single most likely correctness bug in this component. Storage must
be snapshot-capable (LVM-thin or ZFS); refuse `dir` storage at startup with a
clear error rather than failing on the first fork.

VMID allocation is a shared 100–999999999 integer space and Proxmox will happily
race two concurrent creates onto the same id. Allocate from our own SQLite
counter with a uniqueness constraint, then confirm against
`GET /cluster/nextid`.

## Warm pool — the whole ballgame

Cold create is 6.4 s. Claiming a pre-started container is 0.89 s. sandbox hits
0.76 s. There is no clever way to boot a machine in under a second; the pool is
the design, not a tuning pass.

```
pool key = (provider, machine_type, environment_version)
```

- Each key keeps N pre-created, **already started** instances, cloned
  `--full 0` from a golden snapshot.
- `create` = claim from pool → inject env vars / secret files / repos → rename →
  register → return `ready`. Target ≤1.5 s.
- Claim must be atomic: `UPDATE ... SET claimed_by = ? WHERE id = (SELECT ...
  WHERE claimed_by IS NULL LIMIT 1) RETURNING id`. Two concurrent `ori new`
  calls handing out the same container is the worst bug this system can have —
  one tenant's secrets in another tenant's sandbox.
- Refill runs in the background, rate-limited, never on the request path.
- Pool miss falls back to the cold path and says so in the event stream.
- Pool members must be scrubbed on release, never recycled between tenants. A
  claimed instance that is returned is destroyed, not re-pooled.
- Golden snapshot is rebuilt when the environment version changes; old pool
  members for a superseded version are drained.

## Stop / resume / fork

Modelled on measured reality, not on wishful CRIU.

- `stop` = power off, then `snapshot` the stopped container. ~3.4 s measured.
  The snapshot is taken **while stopped** — a running-taken snapshot is
  permanently ~20x slower to clone from (docs/BENCHMARKS.md §Root cause), so
  every stopped sandbox carries a fast-cloneable snapshot for `fork`. Keep the
  disk; do not destroy. Emits `stopping` → `stopped`.
- `resume` = `start` the retained instance. 3.85 s to exec. If the instance is
  gone (host rebuild, capacity move), fall back to `clone_from(latest_snapshot)`.
  Never `rollback` — that path costs ~47 s.
- `fork` = `clone_from` the newest **stopped-taken** snapshot, then start.
  Never snapshot a live source. ~7-9 s. When the source is running, the fork
  omits writes made since the last stop; the stream states this in a `notice`
  event. A running source with **no** stopped snapshot is the common path —
  fork stops it, snapshots it stopped, restarts it, then clones (≈10 s, a few
  seconds of downtime). The downtime is announced on the stream before the
  stop, and the source is restarted before cloning so a failed fork never
  leaves it powered off. `--no-stop` refuses instead, naming the cost.
- sandbox relocates on resume and its IP changes; ours may too once there is more
  than one node. Do not let anything cache the IP across a stop.

## State, not statelessness

SQLite (WAL) in the server, one file. Holds sandboxes, snapshots, environments and
versions, api keys, webhooks, pool slots, vmid allocations, deletion operations.
Postgres is a later swap behind a repository trait if a second control-plane
node ever exists — not now, and not speculatively abstracted for.

Reconciliation loop: the provider is the source of truth for whether a container
exists; SQLite is the source of truth for intent. On startup and every 30 s,
reconcile — a container Proxmox has and we do not is an orphan to destroy, a sandbox
we think is `ready` that Proxmox says is stopped goes to `error`.

## Access paths

- **`exec`** — guest agent over an outbound tunnel from sandbox to control
  plane. No inbound ports on the sandbox. Target ≤1 s round trip.
- **`ssh`** — control plane proxies; guest `sshd` binds loopback only. Client
  manages its own ed25519 key.
- **`host <port>`** — stable HTTPS URL per sandbox+port, private (token-gated) by
  default, `--public` opt-in. Reverse proxy on the control plane keyed by
  subdomain.
- **`forward`** — local TCP listener tunnelled through the control plane.
- **`desktop`** — guest-side VNC/WebRTC, URL minted with a token.

## Non-goals for v1

`ori prompt` / `interrupt` / `events` drive vendor AI agents inside the sandbox.
Implement the endpoints and the event stream shape, but the agent runner itself
is out of scope for the first cut — say so in the response rather than faking it.
Teams and billing: model the fields, return a single personal scope.
