# C9 — golden image builder + host preflight

**You own:** `infra/**`, `scripts/golden-*.sh`, `scripts/preflight.sh`.
No Rust crates.

Read: `docs/BENCHMARKS.md` (why the pool exists), `docs/ARCHITECTURE.md`
(warm pool, Proxmox provider), `plans/C5-pool.md`.

The warm pool clones from a **golden snapshot**. Without a reproducible golden
image there is no pool, and without the pool the create target is unreachable.
This card is on the critical path, not an ops afterthought.

## Deliver

1. **`scripts/golden-build.sh`** — build a golden LXC on a Proxmox host and
   leave it as a stopped container with a snapshot named `base`:
   - base template: Alpine for the fast tier, Ubuntu 24.04 for the full tier
     (measured cold create 2.24 s vs 5.34 s — offer both, default Ubuntu since
     that is what users expect from a dev sandbox)
   - `--unprivileged 1`, `--features nesting=1` (docker-in-sandbox needs it)
   - install: `sshd` bound to **loopback only**, the `ori agent` binary, docker,
     git, a non-root work user, and a VNC/desktop stack for `ori desktop` parity
   - **stop the container, then snapshot.** Clone timings in
     `docs/BENCHMARKS.md` (1.65–1.83 s) are only valid from a stopped, clean
     golden. Cloning from a running or recently-rolled-back source measured
     44 s.
   - idempotent and re-runnable; a second run replaces the snapshot cleanly
   - print the resulting `vmid` + snapshot name as the pool's config input

2. **`scripts/preflight.sh`** — validate a host *before* `ori serve` trusts it:
   - storage supports snapshots (LVM-thin or ZFS). A `dir` storage cannot
     snapshot or linked-clone; fail loudly here rather than at the first fork.
   - the API token can create, clone, snapshot and destroy (actually do it on a
     scratch vmid, then clean up — permission bits lie, a real round trip does not)
   - bridge exists and hands out DHCP
   - template tarballs present
   - report free space and the pool's headroom against the configured depth
   - **assert CRIU is unavailable** and record it, so nothing later assumes
     live suspend works: `pct suspend` measured rc=255 on this kernel

3. **`infra/systemd/`** — units for `ori serve`, with restart policy, and a note
   that the reconciliation loop must run on startup because state drifts while
   the server is down.

4. **`infra/README.md`** — how to stand the whole thing up from a bare Proxmox
   host, in order, with the measured expectations at each step so an operator
   can tell "slow" from "broken".

## Done means

`scripts/preflight.sh` passes against the real host and `scripts/golden-build.sh`
produces a container that `pct clone --full 0 --snapname base` turns into a
working sandbox in under 2 s. Prove it with a timed run pasted into the README.
Never leave scratch containers behind, including on failure (`trap`).
