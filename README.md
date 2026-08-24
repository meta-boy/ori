<h1 align="center">ori</h1>

<p align="center">
  <strong>Self-hosted cloud sandboxes.</strong><br>
  Disposable Linux machines with snapshot → resume → fork,<br>
  on a pluggable container/VM backend you own.
</p>

<p align="center">
  <a href="https://github.com/meta-boy/ori/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/meta-boy/ori/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Rust" src="https://img.shields.io/badge/rust-stable-orange?logo=rust">
  <img alt="Tests" src="https://img.shields.io/badge/tests-235%20passing-brightgreen">
  <img alt="Platforms" src="https://img.shields.io/badge/macOS%20%7C%20Linux-arm64%20%7C%20x64-blue">
</p>

---

```console
$ ori new --type small
ready ori_a1b2c3d4
  ip:      10.0.0.12
  ssh:     ori ssh ori_a1b2c3d4
  forward: ori forward ori_a1b2c3d4 --remote 3000

$ ori exec ori_a1b2c3d4 -- uname -r          # 0.11 s, over the agent tunnel
6.12.48-0-lts

$ ori stop ori_a1b2c3d4                      # snapshots on the way down
$ ori fork ori_a1b2c3d4                      # new machine from that snapshot
ready ori_e5f6a7b8
```

One binary, three roles:

| | | |
|---|---|---|
| `ori <command>` | client | macOS + Linux, arm64 + x64 |
| `ori serve` | control plane | the backend you host |
| `ori agent` | guest agent | inside each sandbox (Linux only) |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/meta-boy/ori/main/install.sh | \
  ORI_INSTALL_BASE_URL=https://github.com/meta-boy/ori/releases/latest/download bash
```

Installs to `$HOME/.local/bin` — **no sudo**. If that is not on your PATH, the
installer tells you and prints the line to add:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

The installer detects your OS and architecture, reads `latest.json` from the
release, and **verifies the SHA-256 before writing anything**. It is safe to
re-run — it reports `already up to date` rather than reinstalling — and it
refuses to downgrade or cross a release channel unless you pass `--yes`.

| env | flag | |
|---|---|---|
| `ORI_INSTALL_DIR` | `--dir PATH` | install directory (default `$HOME/.local/bin`) |
| `ORI_INSTALL_VERSION` | `--version X` | pin a version (default `latest`) |
| `ORI_INSTALL_BASE_URL` | `--base-url URL` | release base, or a local `dist/` directory |
| `ORI_INSTALL_FORCE=1` | `--yes` | allow downgrade, channel jump, or overwrite |

Pin a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/meta-boy/ori/main/install.sh | \
  ORI_INSTALL_BASE_URL=https://github.com/meta-boy/ori/releases/download/v0.1.1 \
  ORI_INSTALL_VERSION=0.1.1 bash
```

Prebuilt targets: `aarch64-apple-darwin`, `x86_64-apple-darwin`,
`aarch64-unknown-linux-musl`, `x86_64-unknown-linux-musl`. The Linux builds are
static musl, so the `agent` role drops into any image.

Prefer to do it by hand? Every release carries `sha256sums.txt`:

```bash
BASE=https://github.com/meta-boy/ori/releases/latest/download
curl -fsSLO "$BASE/ori-0.1.1-aarch64-apple-darwin.tar.gz"
curl -fsSLO "$BASE/sha256sums.txt"
shasum -a 256 -c sha256sums.txt --ignore-missing   # sha256sum -c on Linux
tar xzf ori-0.1.1-aarch64-apple-darwin.tar.gz      # -> ./ori
```

Or build it: `cargo build --release` produces one binary at `target/release/ori`.

### Upgrading

Re-running the installer is the simplest upgrade, and does nothing if you are
current:

```bash
curl -fsSL https://raw.githubusercontent.com/meta-boy/ori/main/install.sh | \
  ORI_INSTALL_BASE_URL=https://github.com/meta-boy/ori/releases/latest/download bash
```

If you run a control plane, the CLI can update itself:

```bash
ori self-update          # prompts before applying
ori self-update --yes    # no prompt
```

> `self-update` asks **your control plane** where releases live — it calls
> `GET /api/v1/cli/version`, which returns the server's `ORI_RELEASE_BASE_URL`.
> So it needs a reachable `ori serve` started with that variable set, for
> example
> `ORI_RELEASE_BASE_URL=https://github.com/meta-boy/ori/releases/latest/download`.
> Without one it exits with a network error against the configured api-url — use
> the `curl` form above instead. It then runs the same `install.sh`, so the
> checksum and no-downgrade guarantees are identical.

## Status

The command surface is **complete** — no stubs, no `unimplemented!()` in
non-test code, help text asserted against the spec in CI.

Verified end-to-end through the CLI against a live Proxmox host:

| | measured | |
|---|---|---|
| `ori new` | **1.44 s** warm / ~9 s cold | warm pool hit vs. cold create |
| `ori exec` | **0.11 s** | over the agent tunnel; 2.7 s provider fallback |
| `ori stop` | 4.7 s | real snapshot on the host |
| `ori resume` | 5.4 s | data intact |
| `ori fork` | 8.9 s | clones the stopped-taken snapshot |
| `ori delete` | 1.3 s | async operation, container removed |
| `ori ssh` / `scp` / `forward` | verified | real `sshd`, byte-exact copies, HTTP 200 |

**Three caveats before you rely on it:**

- **Only the Proxmox backend is reachable.** Docker, Firecracker and Apple
  Containers are implemented behind the `Provider` trait — and Docker passes a
  full lifecycle against a live daemon — but `ori serve` cannot select them yet.
  `ORI_PROVIDER=docker` fails at startup.
- **`prompt` / `interrupt` / `events` don't work yet.** The control plane and
  CLI are done, but the sandbox image ships no `claude`/`codex`/`node`, so there
  is nothing to drive.
- **`host` is a slug-routed reverse proxy, not HTTPS.** Wildcard DNS and a TLS
  terminator in front are yours to supply.

`docs/STATUS.md` has the exact matrix.

## Use a sandbox

```bash
ori login <api-key> --api-url https://ori.example.com

ori new --type small                    # or --from <named-snapshot>
ori ssh <id>                            # real ssh: scp and VS Code Remote work
ori exec <id> -- cargo test
ori forward <id> --remote 3000          # port to localhost
ori host <id> 3000                      # port on a stable URL
ori snapshot save <id> my-baseline
ori fork <id>                           # branch a machine
```

Reusable machine setup lives in an **environment** — repos, variables, secret
files, and safety toggles, versioned so running sandboxes stay pinned until you
`ori env upgrade`:

```bash
ori env new backend
ori env set-var backend DATABASE_URL=postgres://…
ori env add-repo backend https://github.com/you/api@main
ori new --environment backend
```

## Run the control plane

```bash
ORI_PROVIDER=proxmox \
ORI_AGENT_PLANE_URL=ws://<reachable-addr>:8100/api/v1/agent/tunnel \
  ori serve --bind 0.0.0.0:8100 --domain ori.example.com
```

Proxmox config comes from `ORI_PVE_*` (host, token, node, storage, bridge,
template). Run `scripts/preflight.sh` first — it proves the host can really
create, snapshot, clone and destroy with a live round trip instead of trusting
permission bits.

`ORI_AGENT_PLANE_URL` is required and cannot be inferred: binding `0.0.0.0` says
nothing about what a sandbox can route to, and the loopback case fails silently —
the machine comes up, the agent never connects, and every `exec` quietly takes
the slow path.

To let clients run `ori self-update`, tell the server where releases live:

```bash
ORI_RELEASE_BASE_URL=https://github.com/meta-boy/ori/releases/latest/download
```

Leave it unset and `self-update` still reports correctly when you are current,
but the moment a newer version exists it fails with *"an update to X is
available but the control plane did not provide a release base URL"* — it has
nowhere to fetch from.

Turn on the warm pool to make `new` fast:

```bash
ori serve --pool-depth 4 --pool-golden <node>/<vmid>/<snapname>
```

> The golden snapshot **must have been taken while the source was stopped.**
> Cloning from a running-taken snapshot costs ~45 s instead of ~1.7 s —
> permanently, and the penalty belongs to the snapshot, not the source.

## Pluggable backends

The control plane talks to a `Provider` trait, never to a hypervisor. Each
backend declares the capabilities it actually has, and the server degrades
instead of assuming. Adding Docker required **no trait change**, which is the
evidence the abstraction is real rather than indirection around one backend.

| Backend | Verified against real infra | Reachable from `ori serve` | Linked clone | FS snapshot | Live suspend |
|---|---|---|---|---|---|
| **Proxmox LXC** | ✅ live host | ✅ | yes | yes | no — CRIU measured failing |
| **Docker** | ✅ live daemon | ❌ not wired | yes (layers) | yes (commit) | no |
| Firecracker | ❌ needs KVM host | ❌ not wired | no | no | **yes** — real snapshot/restore |
| Apple Containers | ❌ needs `container` CLI | ❌ not wired | no | no | no |

A generic conformance suite runs against any backend claiming a capability, so a
declared capability has to be real. It earns its keep: running it against the
live host caught Proxmox violating its own idempotency contract, because PVE
reports "already gone" as a `500` with a message rather than a `404`.

Provider-level lifecycle, same machine shape, same run:

| | create | snapshot | clone | start | exec | stop | resume |
|---|---|---|---|---|---|---|---|
| Proxmox LXC | 5.87 s | 0.70 s | 1.71 s | 3.39 s | 1.70 s | 2.89 s | 3.47 s |
| Docker | 0.18 s | 0.14 s | 0.05 s | 0.08 s | 0.03 s | 2.16 s | 0.07 s |

## How it fits together

```
ori <cmd> ──HTTPS/NDJSON──▶  ori serve  ──REST──▶  Proxmox / Docker / …
                             │  SQLite (WAL)
                             │  warm pool · TTL reaper · reconcile loop
                             │  webhooks (HMAC) · slug reverse proxy
                             ▼
                       agent tunnel  ◀──outbound WS── ori agent (in sandbox)
                                                       exec · forward · files
```

The sandbox dials **out** to the control plane, so no inbound port, public IP or
NAT traversal is needed per machine. `ssh` and `scp` are real SSH spliced over
that tunnel via `ProxyCommand` — ori implements neither, it just carries the
bytes, so anything built on ssh works too (VS Code Remote, and `rsync` once you
add it to the image; the default one ships without it).

Five crates: `ori-proto` (the shared wire contract, no I/O — enforced),
`ori-providers` (backends), `ori-server` (control plane), `ori-cli`, `ori-agent`.

## Build

```bash
cargo build --release      # one binary: target/release/ori
cargo test --workspace     # 235 tests, no infrastructure required
```

Provider tests are mocked with `wiremock`, so the UPID poller, clone arguments
and idempotency guards are exercised without a host. Real-backend tests are
opt-in:

```bash
cargo test -p ori-providers --features docker -- --ignored
```

## Docs

| | |
|---|---|
| `docs/STATUS.md` | what works, what doesn't, measured |
| `docs/ARCHITECTURE.md` | crates, `Provider` trait, warm pool |
| `docs/BENCHMARKS.md` | measurements, targets, root causes |
| `docs/SPEC-CLI.md` · `docs/SPEC-API.md` | command surface, wire protocol |
| `docs/PROXMOX-REST.md` | verified REST recipe, UPID contract, traps |
| `docs/DIVERGENCES.md` | every known gap, plus a systemic post-mortem |
| `docs/CODE-REVIEW.md` | maintainability review |

The docs are written to be falsifiable: `BENCHMARKS.md` keeps a hypothesis that
measurement **disproved** and the corrected root cause, and `DIVERGENCES.md`
records the failure mode this project kept hitting — components that were
individually correct and collectively unreachable, because nobody owned the
joins.
