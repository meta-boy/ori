<h1 align="center">ori</h1>

<p align="center">
  <strong>Self-hosted cloud sandboxes.</strong><br>
  Disposable Linux machines with snapshot → resume → fork,<br>
  on a pluggable container/VM backend.
</p>

---

**Status: working core, partial surface.** The create/exec/snapshot/stop/resume/
fork/delete lifecycle is implemented and verified against a real Proxmox host.
Access commands (`ssh`, `scp`, `forward`, `host`, `desktop`) and account
management (`env`, `api-key`, `webhook`, `team`, `limits`, `snapshots`) are
**not implemented** — they error cleanly rather than pretending.
See `docs/STATUS.md` for the exact matrix.

One binary, three roles:

```
ori <command>     client        macOS + Linux, arm64 + x64
ori serve         control plane self-hosted backend
ori agent         guest agent   runs inside each sandbox (Linux only)
```

## Use a sandbox

```bash
ori login <api-key> --api-url https://ori.example.com
ori new --type small
ori exec <id> -- uname -a
ori fork <id>
```

`ori ssh` is not wired yet — use `ori exec` for now.

## Run the control plane

```bash
ori serve --provider proxmox --pool-depth 0
```

Proxmox config comes from `ORI_PVE_*` (host, token, node, storage, bridge,
template). Run `scripts/preflight.sh` first — it proves the host can actually
create, snapshot, clone and destroy with a real round trip rather than trusting
permission bits.

## Pluggable backends

The control plane talks to a `Provider` trait, not to a specific hypervisor.
Each backend declares what it can actually do and the server degrades rather
than assuming. Docker required **no trait change**, which is the evidence the
abstraction is real rather than indirection around one backend.

| Backend | Status | Linked clone | FS snapshot | Live suspend |
|---|---|---|---|---|
| Proxmox LXC | implemented, verified on a live host | yes | yes | **no** — CRIU measured failing |
| Docker | implemented, verified on a live daemon | yes (image layers) | yes (commit) | no |
| Firecracker | stub | no | no | **yes** — genuine snapshot/restore |
| Apple Containers | stub | no | no | no |

Stubs return `ProviderNotImplemented` from every method — a stub that returns
`Ok(())` is worse than an absent one. A generic conformance suite runs against
any provider claiming a capability, so a declared capability has to be real.

## Performance

Measured end to end through `ori` against a real Proxmox host:

| operation | measured |
|---|---|
| `new` (cold) | 9.2 s |
| `exec` | 2.7 s |
| `stop` (snapshot + power off) | 4.7 s |
| `resume` | 5.4 s |
| `fork` | 9.1 s |
| `delete` (API returns) | 1.3 s |

Two things dominate the design, both established by measurement:

- **A warm pool is the only way to make `new` fast.** Cold create is ~6.4 s;
  claiming a pre-started container is ~0.89 s. The pool is implemented and wired
  into `new`, but does not fill yet (no golden snapshot is registered in
  production) so every create currently pays cold cost.
- **Never clone from a snapshot taken while the container was running.** It costs
  ~45 s versus ~2 s from a stopped-taken snapshot, permanently, and the penalty
  belongs to the snapshot rather than the source. `fork` clones from the snapshot
  `stop` already takes, which is why it is 9 s and not 51 s.

`docs/BENCHMARKS.md` has the full data, including a falsified hypothesis and a
corrected root cause.

## Docs

| | |
|---|---|
| `docs/STATUS.md` | what works, what is stubbed, measured |
| `docs/ARCHITECTURE.md` | crates, `Provider` trait, warm pool |
| `docs/BENCHMARKS.md` | measurements, targets, root causes |
| `docs/SPEC-CLI.md` / `docs/SPEC-API.md` | command surface, wire protocol |
| `docs/PROXMOX-REST.md` | verified REST recipe, UPID contract, traps |
| `docs/DIVERGENCES.md` | every known gap, and a systemic post-mortem |
| `docs/CODE-REVIEW.md` | maintainability review |
