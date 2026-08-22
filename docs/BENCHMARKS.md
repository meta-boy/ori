# Performance baselines and targets

Measured 2026-08-23 on the project's own Proxmox host: 8 cores, 14 GB RAM,
pve-manager 9.1.9, kernel 7.0.0-3-pve, `local-lvm` backed by LVM-thin.
Reproduce with `scripts/bench-lxc.sh`.

Every number is **time to first successful `exec`**, not time to a "ready"
status. Those differ by seconds on any container runtime, and only the former
is what a user experiences.

## LXC primitives

| Operation | Measured | Notes |
|---|---|---|
| `pct create` from Alpine template | 2.24 s | rootfs extract dominates |
| `pct create` from Ubuntu 24.04 template | 5.34 s | larger rootfs |
| `pct start` → `exec` succeeds | 3.0 – 4.4 s | **the dominant cost in every path** |
| cold create total (Alpine) | **6.4 s** | |
| cold create total (Ubuntu) | **9.4 s** | |
| `pct clone --full 0` (linked, LVM-thin) | **1.65 – 1.83 s** | O(1) in disk size |
| linked clone + start + exec-ready | **5.7 – 6.0 s** | |
| DHCP address up inside container | 0.85 s | |
| `pct snapshot` (LVM-thin) | **1.15 s** | |
| `pct stop` | 2.21 s | |
| snapshot + stop (our `stop`) | **3.37 s** | |
| `pct start` after stop (our `resume`) | 3.0 s, exec-ready **4.4 s** | |
| `pct exec` round trip | **0.90 s** | floor for `ori exec` |
| warm-pool claim (inject config + probe) | **0.89 s** | |
| 4 parallel linked clones, all ready | 6.8 s | |
| `pct suspend` (CRIU live suspend) | **FAILS**, rc=255 | `do_dump: dump failed` |

## Three findings that dictate the design

**1. A warm pool is the design, not an optimization.**
Cold create is 6.4 s. Claiming a pre-started container is 0.89 s — a 7×
difference, and the only way to reach a sub-second-feeling `ori new`. Nothing
boots a Linux machine in under a second. The pool is built with the server
(card C5), not bolted on afterwards.

**2. Live suspend is unavailable and must be a declared capability, not a TODO.**
CRIU checkpointing fails on this kernel (`pct suspend`, rc=255). `stop` is
therefore *filesystem snapshot + power off*, and `Capabilities.live_suspend` is
`false` for LXC. Firecracker genuinely supports snapshot/restore, so the trait
must model this as a per-provider capability rather than assume one behaviour.

**3. `pct rollback` is quarantined.**
The call returns in ~1.4 s, but the container then takes **~47 s** to become
executable. Measured across four configurations:

| case | rollback call | then start → exec |
|---|---|---|
| linked clone, rolled back while running | 2.95 s | 46.8 s |
| linked clone, rolled back while stopped | 1.35 s | 46.6 s |
| plain container, rolled back while stopped | 1.37 s | 47.2 s |
| same container, second rollback | 1.39 s | 48.6 s |
| **control: plain stop + start, no rollback** | — | **4.4 s** |

It is not caused by rolling back a running container, and it is not caused by
thin-pool block zeroing — tested with `lvchange --zero n` and back, results were
identical within noise (47.47 s vs 47.50 s), so **do not ship that as a tuning
recommendation**. Worse, a rollback poisons the *next* thin-pool operation: a
linked clone immediately after one took **44.7 s** instead of 1.7 s.

Consequences, which the `Provider` trait must enforce rather than document:
`resume` is a plain `start` on the retained disk, `fork` is
`clone --full 0` from a snapshot, and `rollback` never appears on a request path
or in the pool refill loop.

Also note: the 1.65–1.83 s clone figure is **only valid from a stopped, clean
golden snapshot** — the configuration the pool actually uses.

## Targets

| Operation | Target | Floor |
|---|---|---|
| `new` (pool hit) | ≤ 1.5 s | 0.89 s |
| `new` (pool miss, cold) | ≤ 7 s | 5.7 s |
| `exec` round trip | ≤ 1.0 s | 0.90 s |
| `stop` | ≤ 5 s | 3.37 s |
| `resume` | ≤ 4.5 s | 4.4 s |
| `fork` | ≤ 7 s | 5.7 s |
| `delete` (API returns) | ≤ 1 s | async op, work happens in background |
| pool refill per slot | ≤ 6 s | off the request path |

`delete` returning in under a second requires it be asynchronous — the
underlying stop + destroy is ~3.4 s. Return an operation id immediately and do
the work in the background.

## Root cause: the 45 s clone penalty belongs to the snapshot

Earlier notes blamed `pct rollback`. That was wrong. A controlled four-case
experiment isolates it exactly — same container, same storage, same `--full 0`
flag, only the snapshot's origin varies:

| snapshot taken while source was | source state at clone time | clone |
|---|---|---|
| **running** | running | **44.92 s** |
| stopped | stopped | **2.55 s** |
| **running** | stopped | **44.99 s** |
| stopped | running | **2.22 s** |

**The penalty is a property of the snapshot, not of the source.** A snapshot
taken while the container was running is permanently expensive to clone from —
20×, forever, no matter what state the source is in later. A snapshot taken
while stopped is cheap to clone from even while the source is running (case 4).

Proxmox reports `create linked clone` in all four cases and names the same base
volume, so the log gives no hint that anything differs. Only the timing does.

### The rule this produces

**Fork clones from a snapshot that was taken while the container was stopped.**

This composes well with the rest of the design, because `stop` already
snapshots after powering off — so every stopped sandbox carries a
fast-clone-able snapshot for free:

| fork source | path | cost |
|---|---|---|
| stopped sandbox | clone latest (stopped) snapshot + start | **≈6.5 s ✅** |
| running sandbox, has a prior stopped snapshot | clone that snapshot + start | **≈6.5 s ✅** |
| running sandbox, no stopped snapshot | stop, snapshot, clone, restart source | ≈10 s, ~5 s source downtime |
| naive: snapshot the live source, then clone | — | **≈52 s ✗** |

The honest limitation of the fast path: forking a running sandbox from its
latest *stopped* snapshot does not include writes made since that stop. That is
a real semantic difference and must be stated in `ori fork`'s output, not
hidden.

### Storage choice matters more than tuning

This is an LVM-thin characteristic. ZFS is expected to clone a snapshot of a
live dataset in O(1), which would remove the constraint entirely — but that is
**unverified here**. A trial on a file-backed zpool (zfs 2.4.3) snapshotted a
running container in 1.42 s and then failed the clone with `rc=2`; the test did
not capture the error text, so the cause is unknown and it may simply be an
artifact of the file-backed pool or the storage's `content` configuration.

Treat ZFS as a promising but untested option, not a recommendation. It is not
on the critical path: the stopped-snapshot fork rule above already meets the
7 s target. Block zeroing was tested and ruled out (see above).
