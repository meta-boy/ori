# Operating this thing

Short, and only the parts that will hurt you.

## `ORI_SNAPSHOT_SECRET` is the single point of total data loss

Every ori's restic repository password is **derived, not stored**:

```
password = HMAC-SHA256(ORI_SNAPSHOT_SECRET, "ori-snapshot-repo:" + KEY_ID + ":" + oriId)
```

`KEY_ID` defaults to `v1` (OPEN-DECISIONS #1, resolved). Repos created before the key id
existed used the un-prefixed derivation `HMAC-SHA256(ORI_SNAPSHOT_SECRET,
"ori-snapshot-repo:" + oriId)`; they still open, because password resolution probes each
repo and falls back to the legacy derivation when the keyed one does not decrypt its
config (`resolveRepoPassword()` in `packages/api/src/snapshots/restic.ts`).

That is a deliberate choice (`packages/api/src/snapshots/restic.ts`). A stored per-ori
password dies with the ori's database row, and **fork has to open the *source* ori's
repository** — including a source that has since been deleted. A derived password needs
only the ori id, which resume (its own) and fork (the source's) always have.

The cost is concentration:

| | |
|---|---|
| **Lose it** | Every snapshot in the system becomes permanently unreadable. There is no per-ori copy to fall back on. Not "hard to recover" — gone. |
| **Leak it** | Every repository is openable by anyone who also has read access to the bucket. |
| **A bucket backup alone is worthless.** | Back the secret up *separately* from the object store, or you are backing up ciphertext you cannot open. |

**Rotation is now possible, one repo at a time.** The key id makes new repos derivable
under a fresh secret while old repos keep resolving to their old password. To rotate:

1. Set `KEY_ID=v2` and change `ORI_SNAPSHOT_SECRET`. Existing repos stay readable
   (resolution falls back to `v1`); NEW repos and re-created repos use `v2`.
2. Existing repos are only re-keyed when they are re-created (a fresh repo gets the
   current `KEY_ID`). Fully re-keying a live repo requires restic's
   `restic key passwd` (or `restic key replace`) inside that ori — there is no
   cross-repo automatic migration, by design.

**Do not change `KEY_ID` casually.** It defaults to `v1`; introducing `v2` starts a
period where every repo you keep is pinned to `v1` forever unless you re-key it.

### Never give it a default

There must be no `process.env.ORI_SNAPSHOT_SECRET ?? "dev"` anywhere. A fallback means
every deployment that forgot to set it shares one password across every ori, and it fails
silently — snapshots work perfectly, and are readable by anyone who knows the default.
Fail to start instead.

## Other things that bite

- **The ori image ships restic 0.16.4; a dev host may have something much newer** (0.19 at
  time of writing). Snapshots are written and read inside the ori by the same binary, so
  this does not bite today. It will the moment anything reads a repo host-side. Pin the
  image's restic, or record a minimum, before adding such a path.
- **Storage credentials handed to a ori are scoped and short-lived by design** (one hour,
  one prefix, enforced by the object store — see `docs/DIVERGENCES.md` and
  `test/api/snapshots/storageCreds.test.ts`). Do not "simplify" this into a shared bucket
  credential. A ori has sudo; whatever is inside it is readable by whoever holds it.
- **`/snapshots/{id}/download` does not return a reconstructable byte stream.** See the
  chunk-model entry in `docs/DIVERGENCES.md`. Recovery goes through restic.
- **A ori whose final snapshot failed stays running and unbilled**.
  That is intentional: keeping the machine alive risks nothing, and destroying it discards
  the customer's work. Do not "fix" it into a forced archive.
- **Idle sandboxes back their auto-snapshot cadence off.** A naive implementation probes
  every ori every minute; here, a sandbox whose disk has not changed since the last
  successful snapshot answers "skipped", and each consecutive skip doubles the probe
  interval (60s → … → 60min cap) until something changes. A change is captured at the
  next probe, so a snapshot can lag an idle sandbox's changes by up to an hour; the
  final snapshot on stop never skips. A snapshot that FAILS resets the backoff, so a broken
  backup is retried at the base 60s and never inherits an idle sandbox's hour.
- **Per-sandbox resource ceilings are `ORI_SANDBOX_MAX_CPUS` / `ORI_SANDBOX_MAX_MEMORY_MB`.**
  They cap every sandbox whatever its machine type asks for; the LXC installer derives them
  from the container's own size. Unset means the type's own numbers are used unclamped.

## The warm tier: stopped oris that resume in seconds, not minutes

A stopped (archived) ori can be **warm** or **cold**, and the difference is entirely
host-disk vs restic:

- **Cold** (the original behaviour): stop destroys the container and the disk is only in
  restic. Resume creates a fresh machine and restores the latest snapshot — minutes on a
  multi-GB ori.
- **Warm**: stop *halts* the container in place instead of destroying it, so a near-term
  resume just starts it again — sub-second. The final snapshot is still taken and registered
  first, so restic remains the durable copy and the warm container is a *cache*, not a
  second source of truth.

On the row, **`archived` + `machineId != null` is warm**; **`archived` + `machineId == null`
is cold** (destroyed on stop, or since evicted). There is no new state and no new column.

The things an operator needs to know:

- **`WARM_KEEP_MS`** (default `86400000`, 24h) is how long housekeeping keeps a warm
  container before evicting it — the reaper destroys it and nulls the `machineId`, returning
  the disk to the host. Eviction only happens after housekeeping confirms a registered
  snapshot exists: a warm container with *no* snapshot is the only copy of its disk, and it
  is never dropped.
- **Warm resume is automatic and free**: `POST /resume` with no `type` (and no `noEnv`)
  starts the kept container. A **resize** (`type` different from the archived row) or
  **`noEnv: true`** forces the cold path — a frozen container cannot be resized, and its
  disk is not trusted to keep credentials. A driver without suspend support (Incus) is
  always cold.
- **Host disk cost**: every warm ori holds its writable layer on the host until eviction or
  delete. The dial is `WARM_KEEP_MS`, not per-ori. If the host disk is tight, lower the
  window; resume just becomes cold more often.
- **`ori rm` reclaims warm disk too**: delete destroys the kept container before dropping
  the row, so a deleted warm ori returns its bytes immediately.
- **The fake driver in tests is suspend-capable**, so the API suites exercise the warm path
  by default; docker supports it for real (`docker stop`/`docker start`). A stopped warm
  container is *not* reported alive by liveness checks — `archived` is not an
  expect-live state — and a stopped container answers nothing, which is what `stop` wants.

## Firecracker driver (stage 1)

Stage 1 of the firecracker driver **boots VMs**; memory-snapshot warm resume is **stage 2**
and not implemented yet. The control plane is started with `ORI_DRIVER=firecracker` in
`/etc/ori/ori-api.env`.

### Host requirements

- **Linux with KVM.** The driver is KVM-only: `/dev/kvm` must exist and be writable by the
  `ori` service user. `infra/bootstrap.sh` (with `ORI_ENABLE_FIRECRACKER=1`) adds `ori` to
  the `kvm` group.
- **firecracker + jailer** in `/usr/local/bin`, installed by `bootstrap.sh` and pinned to
  `FIRECRACKER_VERSION`.
- **A VM bridge**, `ori-fc0` at `172.30.0.1/16`, created and persisted by `bootstrap.sh`
  (netplan), with a MASQUERADE for `172.30.0.0/16` in the same `/etc/iptables/rules.v4`
  that `netfilter-persistent` restores on boot. If you touch the host firewall, remember VM
  egress also needs a FORWARD accept for the fc subnet.
- **The API unit grants access.** Uncomment the firecracker block in
  `infra/systemd/ori-api.service` (CAP_NET_ADMIN, `/dev/kvm`, `/dev/net/tun`). The default
  docker deployment leaves it commented.

### Configuration

- `ORI_DRIVER=firecracker` selects the driver. It **fails to start, loudly**: the startup
  probe refuses to serve until `/dev/kvm` is accessible, `firecracker` and `jailer` exist on
  PATH, the bridge is up, and the kernel/rootfs/agent files below resolve — no silent
  half-configured control plane.

| var | meaning |
|---|---|
| `ORI_FC_SUBNET` | VM subnet, default `172.30.0.0/16` |
| `ORI_FC_STATE_DIR` | per-VM jailer/chroot + state directory |
| `ORI_FC_BRIDGE` | VM bridge, default `ori-fc0` |
| `ORI_FC_KERNEL` | guest kernel image (built by `image/build-fc.sh`) |
| `ORI_FC_ROOTFS` | default guest rootfs |
| `ORI_FC_ROOTFS_<TYPE>` | per-machine-type rootfs override (e.g. `ORI_FC_ROOTFS_sandbox`) |
| `ORI_FC_AGENT_BINARY` | in-guest agent binary staged into the rootfs at boot |

### Image build pipeline

Guest images are built with `image/build-fc.sh` — it produces the kernel/rootfs pair that
feeds `ORI_FC_KERNEL` / `ORI_FC_ROOTFS`. `image/FC-KERNEL.md` documents how the kernel is
configured, patched, and built for KVM.

### Scope

Stage 1: **boots VMs** on KVM. Warm resume from a memory snapshot — and the
control-plane suspend/resume dance that rides on it — is **stage 2**, out of scope for now.
