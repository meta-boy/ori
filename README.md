<p align="center">
  <img src="docs/logo.svg" width="88" height="88" alt="ori">
</p>

<h1 align="center">ori</h1>

<p align="center">
  <strong>Self-hosted cloud sandboxes.</strong><br>
  Throwaway Linux machines with ssh, Docker inside, a desktop over VNC,<br>
  and snapshot → resume → fork to object storage.
</p>

<p align="center">
  <a href="https://github.com/meta-boy/ori/releases"><img alt="release" src="https://img.shields.io/github/v/release/meta-boy/ori?style=flat-square&color=222"></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-678%20passing-222?style=flat-square">
  <img alt="platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux-x64%20%C2%B7%20arm64-222?style=flat-square">
</p>

---

## Use a sandbox — 1 minute

You need a control-plane URL and an API key. No control plane yet? Jump to
[run the server](#run-the-server--15-minutes).

```bash
# 1. install the CLI
curl -fsSL https://raw.githubusercontent.com/meta-boy/ori/main/install.sh | bash

# 2. point it at your server (saved to ~/.config/ori/config.json, mode 0600)
ori login <api-key> --api-url https://oris.example.com

# 3. get a box
ori new --type nano
ori ssh <id>
```

`ori ssh` works from any machine that has logged in — it tunnels through the control plane, so
the sandbox's sshd never leaves loopback and no ports are opened.

## Commands

| | |
|---|---|
| `ori new [--type T] [--ttl S] [--display] [--env K=V] [--no-env]` | create and wait for `ready`. Types: `nano` `small` `default` `large` |
| `ori list [--filter rspte] [--all]` / `ori info <id>` | what exists, how long each has left / one in full |
| `ori ssh <id> [cmd]` / `ori exec <id> <cmd>` | a shell, or one command (exit code propagates) |
| `ori scp <src> <dst>` / `ori forward <id> --remote P` | copy files / tunnel a TCP port (either side may be `<id>:/path`) |
| `ori stop <id>` / `ori resume <id>` / `ori fork <id>` | snapshot and destroy / rebuild from it / independent copy |
| `ori extend <id> [--hours N|--ttl S|--no-auto-stop]` | change the auto-stop timer |
| `ori delete <id>` | a **stopped** sandbox and its snapshots, permanently |
| `ori prompt <id> --provider codex "…"` | run the agent inside the ori, streaming response events |
| `ori events <id> [--follow]` / `ori interrupt <id>` | watch / stop the agent |
| `ori host <id> <port> [--public]` | expose a service on a stable HTTPS URL (`<subdomain>-<port>.on.<domain>`) |
| `ori snapshot latest|tree|pull <id>` | inspect or download a snapshot (works while stopped) |
| `ori limits` / `ori status` | quota, canStart / who am I |
| `ori dashboard` / `ori config` / `ori completions <shell>` | open the UI / config path / completion script |

Also: `desktop` `snapshots` `api-key list` `logout` `version` `update`. Add `--json` to anything for
JSONL that `jq` can read.

<details>
<summary><strong>Machine sizes</strong></summary>

| type | vCPU | RAM | disk | usable |
|---|---|---|---|---|
| `nano` | 1 | 0.5 GB | 20 GB | 6 GB |
| `small` | 1 | 1 GB | 20 GB | 8 GB |
| `default` | 2 | 2 GB | 40 GB | 20 GB |
| `large` | 4 | 4 GB | 60 GB | 36 GB |

Sized for agent workloads on one spare machine — every rung fits beside the control plane,
postgres and minio on a 16 GB host. The server also caps every sandbox at half the host's CPU
and RAM (`ORI_SANDBOX_MAX_CPUS` / `ORI_SANDBOX_MAX_MEMORY_MB`), because a type is a request,
not a promise the host can keep.
</details>

<details>
<summary><strong>Updating, pinning, uninstalling</strong></summary>

Re-running the installer **is** the update — one script, one code path, so an update never
takes a route that was never tested. Already current? It says so and stops.

```bash
ori update                                    # same thing, from inside the CLI
… install.sh | bash -s -- --version v0.2.1    # pin a release
… install.sh | bash -s -- --dir ~/bin         # somewhere else
… install.sh | bash -s -- --uninstall         # binary only; config and ssh key stay
```

Env twins for pipes: `ORI_VERSION`, `ORI_INSTALL_DIR`, `ORI_FORCE`.

Every download is checked against the release's `SHA256SUMS` before anything runs. macOS builds
are **unsigned** — the installer clears the quarantine flag, which is not the same thing.
</details>

<details>
<summary><strong>When something is wrong</strong></summary>

```bash
ori version                  # build + commit — quote this in a bug report
ori --debug list             # every request, its status, its timing → stderr
ORI_DEBUG=1 ori ssh <id>     # same, where a flag cannot reach (ssh's ProxyCommand)
```

`--debug` writes only to stderr, so `ori --debug list --json | jq` still works.

| symptom | cause |
|---|---|
| `not logged in` | no key stored — run `ori login` |
| `cannot reach the control plane` | wrong `--api-url`, or the server is down |
| `display_disabled` on `ori desktop` | created without `--display`; make a new one with it |
| `ori_not_deletable` | stop it first — delete never destroys a running machine |
</details>

## Run the server — 15 minutes

### On Proxmox, in one line

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/meta-boy/ori/main/infra/lxc/ori.sh)"
```

1. It asks: defaults, or advanced (ID, hostname, cores, RAM, disk, bridge, storage, branch,
   image tier), then shows a summary before touching anything.
2. It builds the container and installs Docker, Bun, restic, the stack, the base image and a
   systemd unit. **~15 min** at `ORI_IMAGE_TIER=core`, **~30 min** at `full`.
3. It prints an **API key** and a **sign-up invite** — the only copies. Both are stored hashed.

Defaults suit a home box that is also running other things: 4 cores, 6 GB, 40 GB disk. Piped or
in cron (`ORI_DEFAULTS=1`) it takes them without asking.

**Run the same line again to update.** It finds the container by hostname, pulls, migrates,
rebuilds the dashboard, restarts, and skips the slow image build when nothing needs it.

More credentials later:

```bash
pct exec <ctid> -- /usr/local/bin/ori-invite --days 7 --note alice
pct exec <ctid> -- /usr/local/bin/ori-key --name laptop
```

Absolute paths matter from the host — `pct exec` runs with a PATH that excludes
`/usr/local/bin`. Inside the container they are just `ori-invite` and `ori-key`.

<details>
<summary><strong>Why the container is privileged (and not tunable)</strong></summary>

- **privileged** — every sandbox is a `--privileged --cgroupns=host` Docker container with a
  writable `/sys/fs/cgroup`, which is what lets systemd run inside it. An unprivileged LXC
  cannot hand that down.
- **`lxc.apparmor.profile: unconfined`** — Docker loads an AppArmor profile per container and
  the default LXC profile denies it. Symptom: `docker run` fails with *"the docker-default
  profile could not be loaded … you need policy admin privileges"* while dockerd looks healthy.
  Containers made before this was added get the lines retrofitted and one restart.

`infra/lxc/test-host-stage.sh` dry-runs the host half against stubbed `pct`/`pveam`/`pvesm` —
31 assertions, no Proxmox needed.
</details>

### From a checkout

Needs Docker, Bun, and `restic` (`brew install restic`).

```bash
docker compose up -d                       # postgres + minio
bun install
cp .env.example .env                       # see docs/OPERATIONS.md before editing
bun run packages/api/scripts/migrate.ts

df -h .                                    # the image needs 4-9 GB; a build that runs out
ORI_IMAGE_TIER=core image/build-docker.sh  # of disk mid-layer takes the daemon down with it

bun run --cwd packages/dashboard build
bun packages/api/src/index.ts &
bun scripts/create-key.ts --name mine      # printed ONCE
```

Then `ori login <key> --api-url http://localhost:8787`, or run the CLI from source with
`alias ori='bun packages/cli/src/index.ts'`.

<details>
<summary><strong>Shell integration — commands with no id</strong></summary>

```bash
eval "$(scripts/shell-integration.sh)"   # or append to ~/.zshrc
ori new                                  # ori: current is or_xxxxxxxx
ori ssh                                  # no id needed
```

The shell owns "current", so two terminals never fight over it.
</details>

## Dashboard

Served by the same process at `/dashboard` — one port, no CORS, no second deploy. React +
Tailwind + shadcn, built with Vite (`bun run --cwd packages/dashboard build`; forget it and the
route returns `503 dashboard not built` with the command, rather than a wall of 404s).

Sign in three ways: **email + password** (signed, revocable `HttpOnly` cookie), **sign up** with
an invite (invite-only on purpose — every account can spawn containers on your host), or
**paste an `ori_live_` key** (kept in `localStorage`, which any XSS can read; prefer signing in).

What it does: sandboxes with search and filters, actions (SSH, Desktop, Stop, Fork, Resume,
Delete), inline rename and TTL extension, a create modal; per-sandbox Overview / Events /
Console / Files / Snapshots; secrets; API keys; account limits.

Behind a tunnel, set `ORI_PUBLIC_URL` to the public **https** origin or desktop links point at
`localhost:8787` and do nothing from your laptop.

## What is actually verified

Unit tests are the floor. These run real containers:

```bash
make verify         # ~680 pass: typecheck, ledger gate, dashboard build, one DB per test file
make e2e-local      # 13/13  create → exec → bytes checked on the container's own disk
make e2e-survival   # 12/12  destroy the container, rebuild from restic, data survives
make e2e-ssh        #  7/7   a real ssh login; unauthorised key and password auth refused
make e2e-sdk        #  9/9   a client GENERATED from the spec drives a real sandbox
make lint-infra     #  8/8   caddy validate + shellcheck + systemd-analyze (LINUX ONLY)
make check-all      #  all of the above, in order
```

`e2e-survival` is the one that matters: it destroys a container, rebuilds it from object
storage, and checks that files and enabled units survive, hand-run processes do **not**, and a
fork is independent of its parent.

`make lint-infra` skips silently on macOS — a check that skips is not a check that passed.

## Built

| | |
|---|---|
| **Contract** | 25 paths / 30 operations; every response validated against the spec; a gate fails the build on an error code that is in neither the spec nor `docs/DIVERGENCES.md` |
| **Control plane** | bearer auth over hashed keys, sessions, invites, `/limits`, rate limits and fleet ceilings, secrets |
| **Lifecycle** | create / stop / resume / fork / delete / events, a reaper for auto-stop and billing, an 83-case (state × action) matrix |
| **Machines** | guest agent on :7777, a real Docker driver with per-sandbox CPU and memory limits |
| **Snapshots** | restic to S3/minio, per-sandbox scoped credentials, 60s cadence, blocking final snapshot, retention, purge-on-delete |
| **SSH** | key authorisation, real logins, and a tunnel through the control plane so `ori ssh` works from anywhere |
| **Desktop** | opt-in per sandbox; browser VNC behind an HMAC token bound to one sandbox, revoked on stop |
| **CLI** | one self-contained binary per platform, `install.sh` for install and update, `--json`, `--debug`, `version` |
| **Agent layer** | `POST /prompt` runs codex/claude-code inside the ori (your credentials), streams `response` events with taskId, `promptRunStatus`, `interrupt`; CLI `ori prompt` |
| **Hosting** | `host <port>` / `ori host` register `https://<subdomain>-<port>.on.<domain>` with a sticky `_token`; Caddy edge client + `ask`/`validate` endpoints; teardown on stop, same URL after resume |
| **Secrets** | account env vars + secret files applied to every ori before ready, pushed live on `POST /secrets`, per-box `--env` overrides, no-env withholding |
| **Image** | Ubuntu 24.04 + systemd, per-sandbox host keys, a Budgie desktop, and the toolchain in `image/manifest.md` (`ORI_IMAGE_TIER=core\|full`) |
| **Infra** | Caddy edge, systemd units, host bootstrap — validated on Linux, not yet deployed |

## Not built, and why

- **The live edge** (`*.on.<domain>`) — the control-plane surface is complete (`ori host`,
  in-box `host`, route registry, Caddy admin client, `_token` gate), but it needs a real
  domain and a routed IPv4 block; on Linux the docker driver dials the container bridge IP.
  Set `ORI_CADDY_ADMIN_URL` on the deployment to turn the edge on, `EDGE_DOMAIN` to the
  domain the Caddyfile serves (the control plane mints `*.on.$EDGE_DOMAIN` URLs), and
  `ORI_EDGE_VALIDATE_DIAL` if Caddy does not reach the control plane at `127.0.0.1:$PORT`.
- **Incus driver** (real VMs) — needs a Linux host with `/dev/kvm`. `MachineDriver` is four
  methods precisely so this drops in.
- **Sunshine/WebRTC 60fps desktop** — VNC works and is the documented
  fallback; H.264 is backlog.
- **Python SDK**, **billing**, **GitHub App** (repositories endpoints are a documented stub).

## Read before operating

- **`docs/OPERATIONS.md`** — `ORI_SNAPSHOT_SECRET` derives every repository password. Lose it
  and every snapshot is unreadable; rotation is possible per-repo via `KEY_ID` but nothing else
  is backed up, and a bucket backup without the secret is worthless.
- **`docs/DIVERGENCES.md`** — everything this returns that the v1 spec does not describe,
  with reasons. Notably `GET /snapshots/{id}/download` does **not** return a reconstructable
  byte stream; recovery goes through restic.

## Layout

```
openapi/ori-v1.yaml     the contract. Only P1 tasks may edit it.
packages/contract       ids, states, machine table, error codes, zod schemas, envelope
packages/api            control plane: routes, drivers, snapshots, reaper, ssh tunnel
packages/guest-agent    runs inside every sandbox on :7777
packages/cli            the `ori` command
packages/dashboard      the web dashboard (served at /dashboard)
packages/sdk-ts         generated TypeScript client (make sdk)
image/                  base image: manifest, provision.sh, Dockerfile
infra/                  Caddy edge, systemd units, host bootstrap, the LXC installer
test/e2e/               the suites that use real containers
plans/                  the task ledger and the loop protocol
```

## Working on it

`make test` gives every test file its own database: Bun runs files in parallel and several
write fleet-wide state, which made a shared database order-dependent. `make test-fast` is the
shared-DB run — fine for an edit loop, and its number is not trustworthy.

`plans/STATE.md` is the ledger, and `make verify` gates its well-formedness. A duplicate row or
a stale `next:` pointer fails the build, because the loop protocol picks "the first TODO" and a
corrupt ledger sends an agent into an infinite re-do.

## The spec is the contract

The HTTP interface is specified first and implemented second: 25 paths, 30 operations and 50
schemas live in `openapi/ori-v1.yaml`, and the server is written to satisfy it. Everything is
namespaced consistently — `/api/ori/v1`, `or_` ids, `ori_live_` keys, `ori.*` envelopes.

`make e2e-sdk` generates a client from that spec and drives a real server with it, so a spec
that has drifted out of shape — or that cannot generate a working client at all — fails the
build rather than being discovered by whoever integrates next. See `docs/OPEN-DECISIONS.md`
for the decisions behind the shape.
