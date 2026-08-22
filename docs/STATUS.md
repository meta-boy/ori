# Status

Verified by running the binaries against a real Proxmox host, not by reading code.

## Working end to end (real LXC containers)

`ori serve --provider proxmox` drives the Proxmox REST API and creates genuine
LXC containers, confirmed by `pct list` on the host.

| Command | State | Measured |
|---|---|---|
| `ori new` | **real** | 9.2 s cold (no pool yet) |
| `ori list` | **real** | |
| `ori info` | **real** | |
| `ori exec` | **real** | 2.7 s (via `pct exec`; guest agent will cut this) |
| `ori stop` | **real** | 4.7 s, real snapshot on host |
| `ori resume` | **real** | 5.4 s, data intact |
| `ori fork` | **real** | 9.1 s, data inherited, parent unaffected |
| `ori delete` | **real** | 1.3 s, async `oriop_…`, container removed |
| `ori login` / `logout` / `status` | **real** | |
| `ori serve` / `ori agent` | **real** | one binary, three roles |

Semantics verified, not assumed: a marker file written before `stop` was present
after `resume`; the same marker appeared in a `fork`; writing to the fork left
the parent unchanged; `exec` returned the container's real hostname matching its
vmid.

## Not implemented — clean errors, no silent no-ops

Every one of these responds `not implemented in this build` and exits non-zero.
None of them pretend to work.

`ssh` · `scp` · `forward` · `host` · `desktop` · `limits` · `snapshots` ·
`snapshot` · `env` · `api-key` · `webhook` · `team` · `data-retention` ·
`dashboard` · `self-update` · `prompt` · `interrupt` · `events`

`ssh`, `scp`, `forward`, `host` and `desktop` all depend on the guest agent and
the control-plane tunnel. `prompt`/`interrupt`/`events` drive a coding agent
inside the sandbox and were scoped out of v1 deliberately.

**This is not yet a full clone of the reference feature surface.** The core
lifecycle — create, exec, snapshot, stop, resume, fork, delete — is real and
measured. The access and account-management commands are not built.

## Backends

| Backend | State |
|---|---|
| Proxmox LXC | implemented, verified against a live host |
| Docker | in progress |
| Firecracker | stub, accurate capabilities |
| Apple Containers | stub, accurate capabilities |

## Known gaps with evidence

- **Warm pool not built.** `new` is 9.2 s cold; a pool claim measured 0.89 s.
  This is the single biggest latency win available.
- **`exec` goes over SSH per call.** 2.7 s vs a 0.90 s `pct exec` floor; the
  guest agent's persistent tunnel removes the per-call handshake.
- **~1,200 lines of duplicated wire types** across `ori-server/src/proto.rs` and
  `ori-cli/src/wire.rs` while `ori-proto` is a placeholder. This already caused
  one production failure (`memoryGb` vs `memoryGB`). See `docs/CODE-REVIEW.md`.
- **VMID allocation** should consult the live node's vmid list, not only our
  counter and `/cluster/nextid`.
- **Self-signed PVE certs** need `ORI_PVE_INSECURE=1` or a CA file.
- **54 `unwrap()`/`expect()`** in non-test code; in a control plane those are
  crashes that take in-flight operations down.

## Tests

`cargo build --workspace` clean. `cargo test --workspace`: **103 passing, 0 failing.**
