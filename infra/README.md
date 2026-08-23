# infra — standing up `ori` on a bare Proxmox host

The whole control-plane stack from a fresh Proxmox install to a warm pool that
serves `ori new` in under a second. Every step below has a **measured
expectation** so an operator can tell *slow* from *broken* — the numbers come
from `docs/BENCHMARKS.md` and from the timed runs recorded at the bottom of
this file, reproduced on the project's own host (8 cores, 14 GB RAM,
pve-manager 9.1.9, kernel 7.0.0-3-pve, LVM-thin).

```
bare Proxmox host
  │  1. storage is LVM-thin or ZFS (snapshot-capable)
  │  2. templates downloaded
  │  3. API token created
  ▼
scripts/preflight.sh      host is fit for ori serve  (~25 s incl. round trip)
  ▼
scripts/golden-build.sh   stopped golden + `base` snapshot (ubuntu ~80 s, alpine ~50 s)
  ▼
scripts/golden-clone-check.sh   clone < 2 s (idle) + sandbox verified
  ▼
infra/systemd/            ori serve, restart=always, reconcile on startup
  ▼
ori serve                 warm pool clones the golden, serves `new` in ≤ 1.5 s
```

## What lives where

```
scripts/lib.sh                 shared: Proxmox API client (token auth), UPID
                               poller, SSH helpers, env loader, LXC helpers
scripts/preflight.sh           host validation before ori serve trusts it
scripts/golden-build.sh        builds a golden image (stopped + snapshot `base`)
scripts/golden-clone-check.sh  proves the golden clones into a working sandbox
infra/systemd/ori-serve.service  systemd unit for the control plane
infra/systemd/README.md          how to install the unit
infra/lxc/ori.sh               docker-in-LXC config for an ori container
                               (referenced from /etc/pve/lxc/<vmid>.conf)
```

Credentials live only in `$REPO_ROOT/.env.local` (git-ignored). Nothing here
prints or commits a token.

## Prerequisites (on the Proxmox host)

**Storage must be LVM-thin or ZFS.** The pool clones linked (`full=0`) from a
snapshot, which a `dir` storage physically cannot do. `local-lvm` (LVM-thin)
is the default Proxmox install layout and is what this guide assumes. If you
see a `dir` storage, fix that before anything else — `preflight.sh` refuses it.

**Templates.** Both tiers must be present on `local`:

```bash
pveam download local alpine-3.23-default_20260116_amd64.tar.xz
pveam download local ubuntu-24.04-standard_24.04-2_amd64.tar.zst
```

The fast tier (alpine) cold-creates in ~2.2 s, the full tier (ubuntu) in
~5.3 s — that gap is why both are offered. Default golden tier is **ubuntu**,
what users expect from a dev sandbox.

**API token.** Create one with rights to manage LXC and read storage/network.
The token needs (at least):

- `VM.Audit`, `VM.Config.Disk`, `VM.Config.CPU`, `VM.Config.Memory`,
  `VM.Config.Network`, `VM.Config.Options`, `VM.Clone`, `VM.Snapshot`,
  `VM.PowerMgmt`, `VM.Monitor` — for the `vmid`/`lxc` subtree
- `Datastore.Audit` — storage + template checks

`preflight.sh` does not trust the permission bits: it proves create / start /
snapshot / clone / destroy with a real round trip on a scratch vmid in the
test range (9000-9099), then removes everything.

## `.env.local`

Copy the shape (never commit it — it is in `.gitignore`):

```bash
# repo-root/.env.local
ORI_PVE_HOST=https://<host>:8006
ORI_PVE_SSH="root@<host> -p 2222"        # or without -p if standard ssh
ORI_PVE_NODE=sandbox
ORI_PVE_TOKEN_ID='root@pam!bx'           # user@realm!tokenid
ORI_PVE_TOKEN_SECRET=<secret>
ORI_PVE_STORAGE=local-lvm                # must be lvmthin or zfspool
ORI_PVE_BRIDGE=vmbr0
ORI_PVE_TEMPLATE_ALPINE=local:vztmpl/alpine-3.23-default_20260116_amd64.tar.xz
ORI_PVE_TEMPLATE_UBUNTU=local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst
# vmid range reserved for scratch/integration tests; the pool must not allocate here
ORI_PVE_TEST_VMID_MIN=9000
ORI_PVE_TEST_VMID_MAX=9099
```

Optional overrides read by the scripts:

```bash
ORI_PVE_POOL_DEPTH=8          # warm-pool depth preflight reports headroom for
ORI_PVE_POOL_SLOT_GB=8        # rootfs size per pooled member
ORI_PVE_GOLDEN_VMID=          # pin the golden image vmid
ORI_PVE_AGENT_BIN=            # path to a built ori-agent to bake into the golden
```

## 1. Preflight

```bash
source .env.local          # or the scripts load it for you
bash scripts/preflight.sh
```

Expectation: everything `[PASS]`, including a full create → DHCP → suspend →
stop → snapshot → clone → destroy round trip in ~20-25 s, and a pool-headroom
report. See the recorded run at the bottom of this file.

What it checks and why:

| check | why |
|---|---|
| storage is lvmthin/zfspool | a `dir` storage cannot snapshot or linked-clone; fail here, not at the first fork |
| token round trip | permission bits lie; a real create/clone/snapshot/destroy does not |
| bridge + DHCP | the sandbox must come up with an IP; proven live in the round trip |
| templates present | both tiers, because the pool keys on (tier, version) |
| CRIU live suspend | asserted *unavailable* and recorded — `pct suspend` measured rc=255 (`do_dump: dump failed`) on this kernel; nothing may assume live suspend works. Preflight records `ORI_LIVE_SUSPEND=false`. |
| free space + pool headroom | depth × slot rootfs must fit under `avail` |

## 2. Build the golden image

```bash
bash scripts/golden-build.sh --template ubuntu --vmid 9500   # default tier
bash scripts/golden-build.sh --template alpine --vmid 9501   # fast tier
```

What it does, in order:

1. create the container from the template — **`--unprivileged 1`,
   `--features nesting=1`** (docker-in-sandbox), `net0` bridged DHCP
2. append the docker-in-LXC config lines (see `infra/lxc/ori.sh` for why):
   `lxc.apparmor.profile: unconfined`, `lxc.cgroup2.devices.allow: a`,
   `lxc.cap.drop:` (empty), and for unprivileged containers
   `lxc.mount.entry: tmpfs sys/module tmpfs ...` (without it, dockerd fails
   its AppArmor self-check on the kernel's `profiles` file, which a uid-100000
   container root can never open)
3. install **sshd bound to loopback only** (control plane proxies SSH in; no
   inbound ports on the sandbox), the **ori agent** binary (pass
   `--agent-bin`, or `ORI_PVE_AGENT_BIN`, or it looks in
   `target/release/ori-agent`; otherwise it warns and the pool injects it at
   claim), **docker** (storage driver `overlayfs`, verified with
   `docker run hello-world`), **git**, a non-root **`work`** user in the
docker group, and a **VNC/desktop stack** — `Xvfb -> x11vnc ->
   websockify -> noVNC`, all loopback-only, started at boot — for
   `ori desktop` parity (see `image/README.md` for the stack, the
   noVNC-vs-KasmVNC decision, the fluxbox window-manager choice, and the
   image-size cost)
4. **stop the container, then snapshot `base`** — clone timings
   (1.65-1.83 s) are only valid from a stopped, clean golden; cloning a
   running or recently-rolled-back source measured 44 s and is a different,
   unusable beast

The script is idempotent: re-running with the same `--vmid` destroys the old
golden (stop → drop snapshot → destroy) and rebuilds cleanly. A `--vmid` that
belongs to a non-golden container is refused unless `--force`. On any failure
it destroys the half-built container (trap) and leaves nothing behind.

Expectations: ubuntu **~80 s** total, alpine **~50 s** total
(create ~5 s / ~2 s, provision ~60 s / ~40 s, stop ~4 s, snapshot ~1 s).
The output ends with the pool's config input:

```
pool config input:
  ORI_GOLDEN_VMID=9500
  ORI_GOLDEN_SNAPSHOT=base
  ORI_GOLDEN_TIER=ubuntu
```

## 3. Prove the golden (clone + working sandbox)

```bash
bash scripts/golden-clone-check.sh --vmid 9500
```

Clones `pct clone <golden> <sandbox> --full 0 --snapname base` into a scratch
vmid in the test range, starts it, and verifies DHCP, sshd (loopback only),
docker (runs hello-world), git, and the `work` user. When the golden ships the
desktop stack it also proves, the way a browser will use it: **X is up**
(`/tmp/.X11-unix/X99`), `fluxbox` is running, `x11vnc` and `websockify` listen
on loopback **only**, and `websockify` completes a WebSocket handshake against
the VNC backend (`image/wscheck.py`). The scratch clone is destroyed on the way
out — including on failure.

Expectation: clone **< 2 s** on an idle host (measured 1.65-1.83 s;
idle-path sample 1.42 s — see the recorded runs), and start → exec-ready in
~4-7 s. **A loaded host stretches the clone to ~2.3-2.8 s** (thin-pool lock
contention); that is *slow*, not broken — a clone over ~5 s on an otherwise
healthy host, or any value near the 44 s running-source figure, is *broken*.

## 4. Run `ori serve`

See `infra/systemd/README.md`. The unit uses `Restart=always` and — critically —
the reconciliation loop must run **once at startup**, not only on its 30 s
tick, because state drifts while the server is down (containers stop, orphans
appear, snapshots get pruned). The unit file carries that note inline.

`ori serve` reads `ORI_GOLDEN_VMID`/`ORI_GOLDEN_SNAPSHOT`/`ORI_GOLDEN_TIER`
from its pool config to know what to clone.

---

## Recorded timed runs (2026-08-23, the project's own host)

Host: AMD Ryzen 5 2400GE, 8 cores, 14 GB RAM, pve-manager 9.1.9,
kernel 7.0.0-3-pve, `local-lvm` (LVM-thin), bridge `vmbr0`.

> **Load caveat that matters:** throughout this recording session the host was
> running a concurrent benchmark harness at load average **~4.5-5.5 on 8
> cores** (plus firecracker VMs and ~10 containers). Thin-pool operations
> contend under that load. The 1.65-1.83 s clone baseline in
> `docs/BENCHMARKS.md` is an **idle-host** figure; this session reproduced it
> once (1.42 s) in a quieter moment and otherwise measured ~2.2-2.8 s. Both are
> recorded below so the numbers are honest.

### `scripts/preflight.sh`

```
== 1. tools / API / node ==
[PASS] found curl (/usr/bin/curl)
[PASS] found jq (/opt/homebrew/bin/jq)
[PASS] found ssh (/usr/bin/ssh)
[PASS] Proxmox API reachable: 9.1 (pve-manager 9.1.9)
[PASS] node sandbox online
== 2. storage (local-lvm) ==
[PASS] storage type lvmthin supports snapshots + linked clones
[PASS] storage serves container images
[INFO] storage: 133.0G available of 141.2G
== 3. templates ==
[PASS] alpine template present: local:vztmpl/alpine-3.23-default_20260116_amd64.tar.xz
[PASS] ubuntu template present: local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst
== 4. bridge (vmbr0) ==
[PASS] bridge vmbr0 exists and is active
== 5. token round trip (create / snapshot / clone / destroy) ==
[PASS] create: vmid 9000 from alpine template (permission + template verified)
[PASS] start: vmid 9000
== 5a. DHCP on vmbr0 ==
[PASS] DHCP handed out 172.16.12.73 on vmbr0 (container boot -> IP)
== 5b. CRIU live suspend ==
[PASS] CRIU unavailable, recorded live_suspend=false (pct suspend rc=255: command 'lxc-checkpoint -n 9000 -s -D /var/lib/vz/dump' failed: exit code 1)
[PASS] snapshot: vmid 9000 snapname=preflight (1s)
[PASS] linked clone: 9000 -> 9001 (full=0, snapname=preflight) in 3s
[PASS] destroy clone 9001
[PASS] destroy original 9000
[INFO] round trip total: 22s (create+start+dhcp+suspend+stop+snapshot+clone+destroy)
== 6. pool headroom ==
[INFO] free: 133.0G | pool footprint (depth 8 x 8G): 64G | headroom after pool: 69.0G
[PASS] pool fits with 69.0G headroom

summary: 19 passed, 0 failed, 0 warnings, 3 info

machine-readable:
  ORI_PREFLIGHT_PASS=1
  ORI_LIVE_SUSPEND=false
  ORI_STORAGE_TYPE=lvmthin
  ORI_STORAGE_AVAIL_GB=133.0
  ORI_POOL_FOOTPRINT_GB=64
  ORI_POOL_HEADROOM_GB=69.0
preflight OK: host is fit for ori serve
```

### `scripts/golden-build.sh --template ubuntu --vmid 9500` (default tier)

> The runs below predate `plans/C18-desktop.md`, which replaced the best-effort
> `xfce4 + x11vnc` install with the loopback-only `Xvfb -> x11vnc -> websockify
> -> noVNC` stack and its boot service. The C18 rebuild of both goldens added
> **~443 MB (ubuntu) / ~428 MB (alpine)** to the rootfs, verified in-build and
> on real clones — see `image/README.md` for the numbers and decisions.

```
existing golden 9500 is ours; rebuilding cleanly
golden container 9500 created from local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst
container started; waiting for it to accept exec
== base packages
== sshd loopback-only
== boot services
== work user
== desktop / VNC (parity for 'ori desktop'; best effort)
== ori agent
== sshd running now (loopback binding verified at boot too)
== verify installed surface
provision ok
sshd binds loopback only: 1]:22

golden build complete
  vmid        = 9500
  snapshot    = base
  tier        = ubuntu
  template    = local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst
  state       = stopped
  rootfs      = local-lvm:16
  agent       = not baked (see WARN above)
  desktop     = installed

timings (wall clock):
  create         7s
  lxc-config     0s
  start          4s
  exec-ready     2s
  provision      63s
  stop           4s
  snapshot       1s
  total          82s

pool config input:
  ORI_GOLDEN_VMID=9500
  ORI_GOLDEN_SNAPSHOT=base
  ORI_GOLDEN_TIER=ubuntu
```

### `scripts/golden-build.sh --template alpine --vmid 9501` (fast tier)

```
golden build complete
  vmid        = 9501
  snapshot    = base
  tier        = alpine
  template    = local:vztmpl/alpine-3.23-default_20260116_amd64.tar.xz
  state       = stopped
  rootfs      = local-lvm:8
  agent       = not baked (see WARN above)
  desktop     = installed

timings (wall clock):
  create         3s
  lxc-config     0s
  start          4s
  exec-ready     1s
  provision      39s
  stop           4s
  snapshot       1s
  total          53s

pool config input:
  ORI_GOLDEN_VMID=9501
  ORI_GOLDEN_SNAPSHOT=base
  ORI_GOLDEN_TIER=alpine
```

### `scripts/golden-clone-check.sh` (ubuntu golden 9500)

```
using scratch clone vmid 9000 (test range, cleaned up after)

== clone (linked, full=0, snapname=base) ==
clone 9500 -> 9000: 2.257s (host load avg: 4.41)
  NOTE: 2.257s — host load was 4.41; the 1.65-1.83 s baseline is an idle-host figure (docs/BENCHMARKS.md)

== start -> exec-ready ==
start -> exec: 6.23s

== sandbox verification ==
  [ok] DHCP address: 172.16.9.50
  [ok] sshd running
  [ok] sshd bound to loopback only
  [ok] git version 2.43.0
  [ok] work user exists
  [ok] docker works (storage driver verified, hello-world ran)

== summary ==
  clone (9500 -> 9000): 2.257s
  start -> exec-ready:       6.23s
  sandbox verified:          PASS (sshd loopback, docker, git, work user, DHCP)
OK: golden 9500 produces a working sandbox
cleaning up scratch clone 9000
```

### `scripts/golden-clone-check.sh` (alpine golden 9501)

```
clone 9501 -> 9000: 2.805s (host load avg: 4.94)
start -> exec: 5.61s
  [ok] DHCP address: 172.16.9.181
  [ok] sshd running
  [ok] sshd bound to loopback only
  [ok] git version 2.52.0
  [ok] work user exists
  [ok] docker works (storage driver verified, hello-world ran)
sandbox verified:          PASS (sshd loopback, docker, git, work user, DHCP)
OK: golden 9501 produces a working sandbox
```

### Clone latency characterisation (this session, on-host, `pct clone ... --full 0 --snapname base`)

| sample set | result |
|---|---|
| BENCHMARKS baseline (idle host) | 1.65 - 1.83 s |
| API clone, 4 runs | 2.410 / **1.418** / 2.473 / 2.312 s |
| pct clone, 24 runs (load 5-6/8) | min 2.139 · median 2.314 · max 2.701 s |
| pct clone, 20 runs (load 5/8) | min 2.181 · median 2.315 · max 2.560 s |
| pct clone, 12 runs (load 5-6/8) | 2.166 - 2.883 s |
| quiet-hunt window (1-min load 3.96) | 2.370 s |
| failed clone (vmid absent) | 1.29 - 1.46 s → the ~1.3-1.4 s fixed overhead, so real clone work is ~0.9-1.4 s under contention |

The **1.418 s API-clone sample** is the sub-2 s idle-path proof; the median
~2.3 s under load is the honest operating number on a busy shared host. Every
number stays far inside the operational budgets the pool tolerates
(`fork` ≤ 7 s, refill ≤ 6 s — `docs/BENCHMARKS.md`).

## Slow vs broken (read this before diagnosing)

| symptom | verdict |
|---|---|
| clone 1.5 - 2.0 s | healthy (idle host) |
| clone 2.0 - 3.0 s on a loaded host | slow, fine — thin-pool contention; record load |
| clone > 5 s | broken — check thin-pool state, LVM locks (`lvs`, `dmsetup status`) |
| clone ≈ 44 s | the running/recently-rolled-back source path — you cloned a warm source, not a stopped golden |
| `pct suspend` anything but rc=255 | capability changed — CRIU now works; re-flag `Capabilities.live_suspend` |
| cold create 2.2 s (alpine) / 5.3 s (ubuntu) | healthy |
| cold create much slower | slow storage / template extract; check I/O |
| storage type `dir` | **do not proceed** — preflight refuses |

## State left on the host

The two goldens are the intended persistent artifacts the pool clones from:

- `9500` — `ori-golden-ubuntu-9500`, stopped, snapshot `base`, ubuntu tier
- `9501` — `ori-golden-alpine-9501`, stopped, snapshot `base`, alpine tier

Nothing else this guide created remains: the preflight round trip and every
clone-check scratch container live in the test range (9000-9099) and are
destroyed by their own traps. If `pct list` shows anything in 9000-9099 you
did not create, it belongs to another tenant of the host — do not destroy it.