# Status

**Final state:** build clean · `cargo fmt --check` clean · 189 tests passing,
0 failing · 1 clippy warning (a 10-argument function — a missing struct) ·
88 files, ~19k lines · 31 commits, clean tree.

Verified against a live Proxmox host with the **release** binary and the warm
pool enabled:

| operation | measured | target | |
|---|---|---|---|
| `new` (warm pool hit) | **0.42 – 1.50 s** | ≤1.5 s | **met** |
| `new` (cold / pool miss) | ~8.8 s | ≤7 s | over |
| `exec` | **0.11 s** | ≤1 s | **met** — via the guest-agent tunnel |
| `stop` (snapshot + off) | **3.7 s** | ≤5 s | **met** |
| `resume` | **4.3 s** | ≤4.5 s | **met** |
| `fork` (source stopped) | **8.9 s** | ≤7 s | close |
| `fork` (source running) | **8.5 s** | ≤7 s | close — clones the stopped-taken snapshot (C12); was 50.8 s |
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
| `ori exec` | **real** | **0.11 s** via the agent tunnel; 2.7 s provider fallback |
| `ori stop` | **real** | 4.7 s, real snapshot on host |
| `ori resume` | **real** | 5.4 s, data intact |
| `ori fork` | **real** | **8.9 s from a stopped source; 8.5 s from a running one** (clones the stopped-taken snapshot, C12) |
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

`ssh` · `scp` · `forward` · `host` · `desktop` · `snapshots` · `snapshot` ·
`env` · `webhook` · `team` · `data-retention` · `dashboard` · `self-update` ·
`prompt` · `interrupt` · `events`

`ssh`, `scp`, `forward`, `host` and `desktop` all depend on the guest agent and
the control-plane tunnel. `prompt`/`interrupt`/`events` drive a coding agent
inside the sandbox and were scoped out of v1 deliberately.

## C16 — advertised-but-missing commands wired (mock-verified)

These were holes in behaviour the API already advertised — the API returned a
value and gave no way to act on it. All wired through the real CLI against a
running `ori serve --provider mock`:

| command | what was missing | now |
|---|---|---|
| `ori extend` | the auto-stop deadline could not be moved | wired to `POST /sandboxes/{id}/extend`; past deadlines refused; response states the new deadline. The **reaper** honours it: a test extends a sandbox past its original TTL, runs `reap_expired`, and proves the sandbox survives the old deadline and dies on the new one |
| `ori operation` | the `oriop_…` id from `delete` was unqueryable | wired to `GET /operations/{id}`; renders `pending\|processing\|blocked\|completed`; `blocked` reports *why* (a snapshot with a dependent incremental cannot be deleted) |
| `ori api-key` | keys could not be listed, rotated or revoked | `create`/`list`/`rotate`/`revoke`; list shows prefix + last four only, the secret is shown once at creation; `rotate` revokes the old key and mints a new secret |
| `ori limits` | **removed** — a quota nobody enforced reads as a guarantee | replaced with a **host capacity guard**: `new` is refused when thin-pool headroom (storage avail − warm-pool footprint, the `scripts/preflight.sh` §6 arithmetic) or free memory cannot fit the requested machine type, naming the short resource |

The per-account `plan`/quota concept is gone from the API (`/me` no longer
reports a plan; `/limits` endpoint deleted). The old `create_hits_quota` and
`limits_reflects_counts` tests were replaced by capacity-guard tests that prove
the refusal names the short resource and that nothing is created.

**This is not yet a full clone of the reference feature surface.** The core
lifecycle — create, exec, snapshot, stop, resume, fork, delete, extend — is
real and measured. The access and account-management commands are not built.

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
- ~~`exec` goes over SSH per call~~ **RESOLVED.** The agent tunnel landed;
  `exec` is 0.11 s, verified with a real agent in a real LXC. The provider path
  stays as the fallback when a sandbox has no live tunnel.
- **The agent does not start by itself yet.** The tunnel was verified by pushing
  the binary and config in by hand, so a sandbox created by `ori new` currently
  has no agent and silently takes the 2.7 s fallback. `plans/C25` closes this.
- ~~**~1,200 lines of duplicated wire types**~~ **RESOLVED.** Every shared wire
  shape now has exactly one definition, in `ori-proto`; the server and CLI both
  import it. `ori-cli/src/wire.rs` went 513 -> 211 lines (25 duplicate
  definitions removed) and `ori-server/src/proto.rs` 993 -> 306. Two whole
  feature areas -- environments and snapshots -- had defined their shapes inline
  in the command files rather than in `wire.rs`, and were consolidated too.

  The duplication was hiding four real defects, all of the same kind: a value
  one side computes and the other cannot see.

  1. `exec --status <pid>` **always rendered an empty state.** The server
     computed `"running"`/`"exited"`/`"failed"` into a variable named
     `_state_name` and discarded it, because its `ExecResponse` had no `state`
     field; the client's copy declared `state` with `#[serde(default)]`, so the
     miss was invisible. The two responses are now separate types
     (`ExecResponse`, `ExecStatusResponse`) and the status endpoint returns the
     state it already knew.
  2. `ExecStatusResponse.exit_code` was `i64` server-side and `Option<i64>`
     client-side. The server sent `unwrap_or(0)`, so a lost pid reported
     **success**. It is `Option` now and a terminal state with no code exits 1.
  3. The env request shapes carried *different halves* of the serde contract:
     the client had `skip_serializing_if` (it writes them), the server had
     `default` (it reads them). Neither copy could round-trip its own output.
     The shared shapes carry both.
  4. `CliVersion` in `ori-proto` was a dead third copy, missing
     `release_base_url` -- the field that tells the CLI where to self-update
     from. Deleted; the real shape is shared.

  `Ready.commands` is also typed now (`Commands`, not `HashMap<String, String>`
  read with `.get("ssh")`), so a misspelt key is a compile error instead of a
  silently absent line.
- **VMID allocation** should consult the live node's vmid list, not only our
  counter and `/cluster/nextid`.
- **Self-signed PVE certs** need `ORI_PVE_INSECURE=1` or a CA file.
- **54 `unwrap()`/`expect()`** in non-test code; in a control plane those are
  crashes that take in-flight operations down.

## Tests

`cargo build --workspace` clean, no warnings. `cargo clippy --workspace
--all-targets`: 2 pre-existing style warnings, unrelated to any wire type.
`cargo test --workspace`: **233 passing, 0 failing.**
