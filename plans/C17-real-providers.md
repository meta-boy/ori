# C17 — Firecracker and Apple Containers: stubs to real

**You own:** `crates/ori-providers/src/firecracker/`, `.../apple_container/`, and
their cargo features. Do **not** touch `.../proxmox/` or `.../docker/` — both are
finished and verified.

## Firecracker — the capability LXC cannot offer

Research settled this and it is worth more than "fill in the stub later":

- Firecracker has real `PUT /snapshot/create` and `PUT /snapshot/load` on its
  REST API — full VM state: CPU registers, memory, open file handles.
- Restore maps the memory file `MAP_PRIVATE`, so pages load **on demand** rather
  than being read up front. Restores are fast; the cost is that the memory file
  must stay for the resumed VM's lifetime.
  <https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md>
- Fly.io runs exactly this in production and reports **resume in a few hundred
  milliseconds**. Our LXC resume measures 4.3 s, so this is roughly a 10x win on
  the operation LXC is worst at.
  <https://fly.io/docs/reference/suspend-resume/>
- Under the jailer, the page-fault handler process, the UDS and the memory file
  must all live **inside the jail**.
  <https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md>

So `live_suspend: true` is correct and is the whole point of this backend.
Implement `stop`/`resume` as snapshot-create / snapshot-load, not power cycling —
otherwise the provider offers nothing LXC does not already do.

Needs: a kernel image, a rootfs, the jailer, one Firecracker process per microVM
with its API socket. Keep the memory-file lifetime rule visible in the code —
deleting it under a resumed VM is the failure that will be hard to debug.

## Apple Containers — declare honestly

`apple/container` runs Linux containers as lightweight VMs on Apple silicon,
Swift, **macOS 26 only**, OCI-compatible, over the `containerization` package.
Shell out to the `container` CLI (`run`, `exec`, `stats`, …).

**No snapshot or checkpoint primitive appears in its documentation.** Note the
distinction in the module docs: `fs_snapshot` and `live_suspend` are `false`
because nothing documents support, **not** because support was tested and found
missing. `stats --no-stream` is a metrics snapshot and has nothing to do with
capturing state — do not wire it to `snapshot()`.

<https://github.com/apple/container> · <https://github.com/apple/containerization>

## Rules

- A method you have not implemented returns
  `Error::ProviderNotImplemented { provider, operation }`. Never `Ok(())` — a
  stub that reports success will be mistaken for working, which is worse than an
  absent backend.
- Every capability you set to `true` must pass that capability's test in the
  existing generic conformance suite (`tests/conformance/`). That suite is what
  keeps the abstraction honest; do not weaken it to make a backend pass.
- Integration tests `#[ignore]`d behind env vars, like the Proxmox ones.

## Done means

`cargo test -p ori-providers --all-features` green, clippy clean, the conformance
suite runs against each backend for every capability it declares, and no
declared capability is unbacked by a passing test.
