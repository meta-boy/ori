# C10 — one cross-platform binary, released

**You own:** `.github/workflows/**`, `scripts/build-*.sh`, `install.sh`,
`Cross.toml`. No crate internals.

Read: `docs/ARCHITECTURE.md` ("Deliverable shape").

The deliverable is **one binary, three roles** (`ori <cmd>` / `ori serve` /
`ori agent`). This card makes that real and installable.

## Deliver

1. **Cross-compilation matrix**, all from one source tree:
   - `aarch64-apple-darwin`, `x86_64-apple-darwin` (client — the dev's machine)
   - `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` (server + agent;
     musl so the agent is a static drop-in for any golden image)
   - the `agent` role is `#[cfg(target_os = "linux")]`; the macOS build must
     still compile and simply not offer it
   - fail the build if the agent binary exceeds a size budget — it is baked into
     every sandbox image and bloat there multiplies

2. **`install.sh`** — `curl -fsSL … | bash`, detects OS/arch, verifies a
   checksum before installing, installs to a user-writable path without needing
   sudo, and is safe to re-run. Print the version it installed and do not
   silently overwrite a newer one.

3. **CI**: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test
   --workspace`, then the release matrix. Clippy denials are not optional here —
   five crates written by different agents in parallel will drift in style and
   in error handling, and this is the only thing that holds the line.

4. **`ori self-update`** support: a version endpoint contract and checksum
   verification. Never update across a channel boundary without saying so.

5. **Reproducible release artifacts** with checksums published alongside.

## Done means

`scripts/build-all.sh` produces every target from a clean checkout, `install.sh`
installs and runs on this macOS arm64 machine, and the musl agent binary runs
inside a real Alpine LXC. CI green on the workspace.
