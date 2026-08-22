# C4 — `ori-providers`: Proxmox LXC backend

**You own:** `crates/ori-providers/**`. Do not edit the workspace `Cargo.toml`
(C1 already declared you) or any other crate.

Read first: `docs/ARCHITECTURE.md` (Proxmox provider + the trait),
`docs/BENCHMARKS.md` (the measured numbers you must not regress).

Depends on the `Provider` trait in `ori-proto`. If it is not there yet, code
against `ARCHITECTURE.md`'s signatures and reconcile.

## Deliver

`impl Provider for ProxmoxProvider` over the **Proxmox REST API**
(`https://host:8006/api2/json`), token auth header
`Authorization: PVEAPIToken=user@realm!tokenid=secret`. `reqwest`, rustls.
Self-signed certs are normal here: accept a configured CA or an explicit
`insecure_skip_verify` flag that is off by default and logged loudly when on.

Feature-gate it: `[features] default = ["proxmox"]`, plus empty `docker`,
`firecracker`, `apple-container` features for C7.

### The thing that will bite you

**Every mutating Proxmox call returns a UPID task id, not a completed
operation.** A 200 means "queued". You must poll
`GET /nodes/{node}/tasks/{upid}/status` until `status == "stopped"` and then
check `exitstatus == "OK"`. Treating the 200 as success is the single most
likely correctness bug in this component — it will produce a provider that
reports `ready` for containers that failed to start. Write the UPID poller
first, route every mutation through it, and test that a failing task surfaces
as an error.

### Mapping (see ARCHITECTURE.md table)

- `create` — `POST /nodes/{n}/lxc`, from `local:vztmpl/...`, `unprivileged=1`,
  `features=nesting=1` (docker-in-sandbox), `net0` bridged DHCP.
- `clone_from` — `POST /nodes/{n}/lxc/{vmid}/clone` with **`full=0`** and
  `snapname=`. Linked clone on LVM-thin: 1.7 s and independent of disk size.
  A full clone is 2× slower and Proxmox refuses it on a running container.
- `snapshot` / `snapshot_delete` — `.../snapshot[/{name}]`.
- `rollback` — implement, but document it as admin-only: measured ~47 s to
  become executable afterwards. `resume`/`fork` must not use it.
- `stop` — snapshot then `.../status/stop`. `StopMode::Force` skips the snapshot.
- `start`, `destroy`, `resize` (`PUT .../config` cores+memory).
- `addresses` — read the DHCP lease / `.../interfaces`; container IP is not
  available the instant it starts, so poll with a deadline.
- `exec` — prefer the guest agent (C6). `pct exec` over SSH is the fallback for
  bootstrap only; mark it clearly as such.

### Capabilities — declare honestly

`linked_clone: true`, `fs_snapshot: true`, `live_suspend: false`,
`nested_containers: true`, `resize_online: false`, `desktop: true`.

`live_suspend` is **false**: `pct suspend` (CRIU) was measured failing with
rc=255 `do_dump: dump failed` on this kernel. Do not implement it, do not
retry it, do not report it as available.

### Preflight, at startup not at first fork

- Refuse a storage that cannot snapshot (`dir`). LVM-thin or ZFS only. A clear
  startup error beats a mysterious failure on the first `fork`.
- Verify the node name, the template exists, and the token can create.

### VMID allocation

Proxmox will race two concurrent creates onto the same VMID. Take the id from
the caller (the server allocates from SQLite with a uniqueness constraint) and
cross-check `GET /cluster/nextid`. Do not allocate inside the provider.

## Done means

- `cargo test -p ori-providers` — unit tests against a mocked HTTP layer
  (`wiremock`) covering: UPID success, UPID failure surfacing as an error, a
  clone request that actually sets `full=0`, storage preflight rejecting `dir`.
- An integration test behind `#[ignore]` + env vars
  (`ORI_PVE_HOST/TOKEN/NODE/STORAGE`) that runs the real lifecycle:
  create → snapshot → linked clone → start → exec → stop → start → destroy,
  asserting each stays inside the `docs/BENCHMARKS.md` budget.
- No `unwrap()` on anything network- or parse-shaped.
