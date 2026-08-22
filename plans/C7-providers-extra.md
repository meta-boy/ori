# C7 — Docker provider + Firecracker / apple-container stubs

**You own:** `crates/ori-providers/src/docker/**`, `.../firecracker/**`,
`.../apple_container/**`, and the feature flags for them. Do not touch
`.../proxmox/**` (C4 owns it).

## Why Docker matters here

The Docker provider is not a feature request, it is the proof that the
`Provider` abstraction is real. An abstraction with one implementation is just
indirection with extra steps. If implementing Docker requires changing the
trait, the trait was wrong — report that rather than bending Docker to fit.

## Deliver

1. **`DockerProvider`** over the Docker Engine API (unix socket / `bollard`).
   - `create` = create container from image; `clone_from` = `docker commit` the
     snapshot image then run from it.
   - `snapshot` = `docker commit` → image tag as the `SnapshotRef`.
   - `stop`/`start`/`destroy` map directly.
   - `exec` = the exec API.
   - Capabilities: `linked_clone: true` (image layers are copy-on-write),
     `fs_snapshot: true`, **`live_suspend: false`** (`docker pause` freezes but
     does not persist, so it is not resume-across-restart — do not claim it),
     `nested_containers` only with privileged, `desktop: false`.

2. **Firecracker + apple-container stubs.** Real `Provider` impls that declare
   accurate capabilities and return a clear
   `Error::ProviderNotImplemented { provider, operation }` from each method.
   A stub that returns `Ok(())` and does nothing is worse than absent — it will
   be mistaken for working. Include a short module doc on what the real
   implementation would need (Firecracker: jailer, kernel + rootfs images,
   snapshot/restore is genuinely supported here so `live_suspend: true` is
   achievable, unlike LXC).

3. **Provider registry** — construct by name from config, surface capabilities
   to the server so it can refuse an operation up front instead of failing
   halfway.

4. **Capability conformance test suite** — one generic test module, run against
   every provider that declares a capability, asserting the declared capability
   actually holds. A provider claiming `fs_snapshot: true` must pass the
   snapshot test. This is what keeps the abstraction honest as backends are added.

## Done means

- `cargo test -p ori-providers --features docker` passes, with the lifecycle
  integration test `#[ignore]`d behind a real Docker socket.
- The generic capability suite runs against Docker and (behind env) Proxmox.
- Stubs cannot be mistaken for implementations.
