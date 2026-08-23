# C25 — the agent must start by itself in every sandbox

**Owns the seam:** a sandbox created by `ori new` has a live tunnel without
anyone touching it.

## Why this exists

The tunnel is built, verified and fast (`exec` 0.11 s against 2.7 s through the
provider). But that verification was done by **hand**: the `ori` binary was
pushed into the container with `pct push`, `/etc/ori/agent.json` was written
manually, and `ori agent` was started over `pct exec`.

So today the tunnel works only for a sandbox someone prepares by hand. Every
sandbox `ori new` produces has no agent, which means `exec` silently falls back
to the slow provider path and `ssh`/`scp`/`forward`/`host` — all of which ride
the tunnel — have nothing to ride.

This is the same shape as the four unreachable components: the piece works, and
nothing wires it into the path that matters.

## Deliver

**You own** `image/`, `scripts/golden-build.sh`, `scripts/golden-clone-check.sh`.
Write no Rust — other agents are in `crates/ori-server` and `crates/ori-cli`.

1. **Bake the agent binary into the golden image.** Build
   `x86_64-unknown-linux-musl` (see `scripts/build-all.sh`; `Cross.toml` is
   configured) and install it in the image. It is the same `ori` binary — the
   agent is a role, not a separate artifact.
2. **A boot unit that starts `ori agent`**, alongside the existing `sshd`,
   `docker` and `ori-desktop` units, so a pooled clone is tunnel-ready with no
   provisioning step. It must:
   - wait for `/etc/ori/agent.json` rather than failing if it is not there yet
     (a pool member is cloned *before* it is claimed, so the config arrives
     after boot);
   - restart on exit, since the agent already reconnects with jittered backoff
     but cannot survive its own process dying;
   - log somewhere findable — during debugging an empty agent log cost real time.
3. **Config contract**, exactly as the agent parses it (`crates/ori-agent/src/config.rs`,
   camelCase): `controlPlaneUrl`, `token`, `sandboxId`, `workDir`. Document the
   file's shape and required mode in `image/README.md`. It carries a credential,
   so **0600, root-owned**.
4. **Size**: report the delta in `image/README.md`. The desktop stack already
   added ~440 MB; the agent is ~14 MB, but say so rather than leaving it unknown.

## Not yours, but say it out loud

Writing `/etc/ori/agent.json` at claim time belongs to the control plane, not the
image. Record in `docs/DIVERGENCES.md` that the image is ready and the injection
side is still open, naming the file that must produce it — so the seam has an
owner instead of being assumed.

## Done means

Clone the golden, boot it, drop a valid `agent.json` in, and the agent connects
to a running control plane **with no other action**. Then reboot the container
and confirm it reconnects on its own. Add both to
`scripts/golden-clone-check.sh`.
