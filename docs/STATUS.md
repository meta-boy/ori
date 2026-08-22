# Status

**Final state:** build clean · `cargo fmt --check` clean · 167 tests passing,
0 failing · 1 clippy warning (a 10-argument function — a missing struct) ·
88 files, ~19k lines · 31 commits, clean tree.

Verified against a live Proxmox host with the **release** binary and the warm
pool enabled:

| operation | measured | target | |
|---|---|---|---|
| `new` (warm pool hit) | **0.42 – 1.50 s** | ≤1.5 s | **met** |
| `new` (cold / pool miss) | ~8.8 s | ≤7 s | over |
| `exec` | 1.9 – 2.7 s | ≤1 s | over — guest agent unreachable |
| `stop` (snapshot + off) | **3.7 s** | ≤5 s | **met** |
| `resume` | **4.3 s** | ≤4.5 s | **met** |
| `fork` (source stopped) | **8.7 s** | ≤7 s | close |
| `fork` (source running) | **50.8 s** | ≤7 s | **fails — see BENCHMARKS correction** |
| `delete` (API returns) | **0.24 – 1.3 s** | ≤1 s | **met** |

Data fidelity verified each run: a marker written before `stop` survived
`resume`, was inherited by `fork`, and writes inside a fork did not reach the
parent.

Verified by running the binaries against a real Proxmox host, not by reading code.

## Working end to end (real LXC containers)

`ori serve --provider proxmox` drives the Proxmox REST API and creates genuine
LXC containers, confirmed by `pct list` on the host.

| Command | State | Measured |
|---|---|---|
| `ori new` | **real** | **1.44 s warm-pool hit**, ~9 s cold miss |
| `ori list` | **real** | |
| `ori info` | **real** | |
| `ori exec` | **real** | 2.7 s (via `pct exec`; guest agent will cut this) |
| `ori stop` | **real** | 4.7 s, real snapshot on host |
| `ori resume` | **real** | 5.4 s, data intact |
| `ori fork` | **real** | **8.7 s from a stopped source; 50.8 s from a running one** - see correction in BENCHMARKS |
| `ori delete` | **real** | 1.3 s, async `oriop_…`, container removed |
| `ori login` / `logout` / `status` | **real** | |
| `ori serve` / `ori agent` | **real** | one binary, three roles |

NDJSON streaming verified genuinely incremental (not buffered): during a real
`new`, lines arrived at +1.14 s, +7.27 s and +9.24 s with a 6.1 s gap between
them. This matters because a buffered response contains identical bytes but
makes the client sit silent for the whole operation.

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

## Release binary — verified

`cargo build --release` produces a single **10.3 MB** `ori` binary (22 MB debug).
Smoke-tested end to end from macOS arm64 against the live host: it served the
control plane on the Proxmox provider, created a real container in **8.49 s**,
and `exec` returned `Linux x86_64` — so the whole chain is genuine, from an
arm64 macOS client through the control plane into an x86_64 Linux container.

## Distribution — verified

`scripts/build-all.sh` produces all four targets; `install.sh` was run on this
machine against a `file://` base:

| target | artifact |
|---|---|
| aarch64-apple-darwin | 4.7 MB |
| x86_64-apple-darwin | 5.0 MB |
| aarch64-unknown-linux-musl | 5.5 MB (static) |
| x86_64-unknown-linux-musl | 5.9 MB (static) |

`install.sh` detected the platform, verified the sha256 **before** writing,
installed to `~/.local/bin` without sudo, and on re-run reported "already up to
date". `latest.json` carries the self-update contract (version, channel,
per-platform url/sha256/size). Both musl binaries run the agent role inside real
Alpine containers; the macOS build compiles without the agent and errors clearly
on `ori agent`.

**Known red:** `cargo fmt --check` (105 files) and
`cargo clippy --workspace --all-targets -- -D warnings` (pre-existing
`ori-server` lints). CI gates both correctly, so CI would fail today.

## Warm pool foundation — verified

`scripts/golden-clone-check.sh --vmid 9501` against the live host:

| step | measured |
|---|---|
| linked clone from `base` snapshot (`full=0`) | **2.40 s** (host load 3.78; 1.65–1.83 s is the idle figure) |
| start → exec-ready | 5.60 s |

Sandbox checks all pass: DHCP address assigned, `sshd` running **and bound to
loopback only**, git present, work user present, and docker actually runs
`hello-world` inside the unprivileged container.

So the pool's source of truth works. What remains is the pool itself — keeping N
of these pre-started and claiming one per `ori new`.

## Backends

| Backend | State |
|---|---|
| Proxmox LXC | implemented, verified against a live host |
| Docker | in progress |
| Firecracker | stub, accurate capabilities |
| Apple Containers | stub, accurate capabilities |

## Known gaps with evidence

- ~~Warm pool not built~~ **RESOLVED.** The pool fills and `ori new` claims a
  warm slot in 1.44 s (target 1.5 s, was 9.2 s). Enable with
  `--pool-depth N --pool-golden <node>/<vmid>/<snapname>`.
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
