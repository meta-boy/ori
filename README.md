<h1 align="center">ori</h1>

<p align="center">
  <strong>Self-hosted cloud sandboxes.</strong><br>
  Disposable Linux machines with SSH, Docker inside, a graphical desktop,<br>
  and snapshot → resume → fork.
</p>

---

One binary, three roles:

```
ori <command>     client        macOS + Linux, arm64 + x64
ori serve         control plane self-hosted backend
ori agent         guest agent   runs inside each sandbox
```

## Use a sandbox

```bash
ori login <api-key> --api-url https://ori.example.com
ori new --type small
ori ssh <id>
```

## Pluggable backends

The control plane talks to a `Provider` trait, not to a specific hypervisor.
Each backend declares what it can actually do, and the server degrades rather
than assuming:

| Backend | Status | Linked clone | FS snapshot | Live suspend |
|---|---|---|---|---|
| Proxmox LXC | implemented | yes | yes | no (CRIU unavailable) |
| Docker | implemented | yes (image layers) | yes (commit) | no |
| Firecracker | stub | yes | yes | yes (real snapshot/restore) |
| Apple Containers | stub | — | — | — |

Capabilities are declared, verified by a shared conformance suite, and honoured
by the server. A backend that claims a capability must pass that capability's
test.

## Docs

| | |
|---|---|
| `docs/SPEC-CLI.md` | command surface |
| `docs/SPEC-API.md` | control-plane API, NDJSON event stream, state machine |
| `docs/ARCHITECTURE.md` | crates, `Provider` trait, warm pool |
| `docs/BENCHMARKS.md` | measured baselines and latency targets |
| `plans/` | task cards |

## Performance

`ori new` is served from a **warm pool** of pre-started containers. Cold create
on LXC is ~6.4 s; claiming a pooled container is ~0.89 s. The pool is the
design, not an optimization — see `docs/BENCHMARKS.md`.
