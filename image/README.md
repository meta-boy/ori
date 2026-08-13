# ori-image — the base ori image

One provisioning script, `image/provision.sh`, shared by two consumers:

1. **Docker driver** (`image/Dockerfile`, built by `image/build-docker.sh`) — local dev and CI
   (P4-07). Container runs **systemd as PID 1** and is started `--privileged` so dockerd runs
   *inside* the ori.
2. **Incus VM image** (`image/build-incus.sh`) — real hosts (P12). Launches a throwaway
   `ubuntu:24.04` VM, runs the *same* `provision.sh` inside it, then publishes the result as an
   Incus image alias.

## What's in it (v1 subset)

See `image/manifest.md` for the pinned list with a one-line reason per entry. Short version:
sshd, docker, restic, tmux, curl, git, gh, ripgrep, jq, ffmpeg, build-essential + cmake, node
(nodesource 20), bun, python3 + pip/venv + uv, go, rustup, a Chrome binary, Xvfb + x11vnc + noVNC.

## Building

### Docker (any laptop/CI)

```sh
image/build-docker.sh            # → ori-base:latest (IMAGE=… to override)
```

Consume it the way P4-07's docker driver will: `--privileged`, mount `/sys/fs/cgroup` and
`/run`, systemd as PID 1. A quick sanity shell:

`--privileged` alone is **not** enough — systemd exits 255. These flags are the
minimum that actually boots, verified on Docker Desktop / arm64:

```sh
docker run -d --privileged --cgroupns=host \
  --tmpfs /run --tmpfs /run/lock \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --name oribase ori-base:latest
sleep 10
docker exec oribase bash -lc 'id user && ls /etc/ssh/ssh_host_*_key | wc -l && systemctl is-active ssh.socket && docker --version && restic version && test -f /etc/ori.env && echo OK'
docker rm -f oribase
```

Check **`ssh.socket`**, not `ssh.service`. Ubuntu 24.04 socket-activates sshd, so
`ssh.service` reads `inactive` on a healthy ori while port 22 is listening (held by
PID 1) and accepting connections. P4-07's healthcheck must not treat that as down.

The image deliberately ships **no** SSH host keys — they are machine identity, and a
shared key would let any ori impersonate any other. `ori-sshhostkeys.service`
generates them per ori before `ssh.service` starts. That is why the check above runs
`ssh-keygen -A` first: a bare `sshd -t` on a fresh image correctly reports
"no hostkeys available", which is not a build error.

### Incus (a real Ubuntu host, not your laptop)

```sh
image/build-incus.sh             # → image alias ori-base/1.0 (ORI_IMAGE_ALIAS=… to override)
```

`build-incus.sh` deliberately **fails fast** if `incus` is missing or the daemon isn't up —
it never half-runs a provision. Requires `infra/bootstrap.sh` (P12) to have initialized the
pool and networking first. VM image build inherits systemd as PID 1.

## System facts the rest of the repo relies on

- User **`user`**, home `/home/user`, passwordless sudo.
- `/etc/ori.env` (root:root, 0644) is sourced by login shells (`/etc/profile.d`), by
  non-interactive/non-login bash (incl. `ssh user@ori cmd`) via `/etc/bash.bashrc`, and by
  systemd units through `EnvironmentFile=/etc/ori.env` (the guest-agent unit does this).
  The guest agent (P4-04) rewrites this file; the wiring is what makes `/env` land everywhere.
- sshd: `PasswordAuthentication no`, `PermitRootLogin no` (`/etc/ssh/sshd_config.d/99-ori-hardening.conf`).
- dockerd is enabled inside the ori (`systemctl enable docker`).
- Xvfb/x11vnc/noVNC are installed as systemd units but **not enabled** — the desktop starts
  lazily (P8); the control plane starts the units on the first desktop request.

## What is deliberately excluded, and why

- **The full polyglot toolchain** (java/mvn/gradle, kotlin, scala, ruby, php, elixir,
  dotnet, R, clang, VS Code, Ghostty) and the agent CLIs (`claude`, `codex`, `lux`, `host`,
  `ori`). Those are a later phase; installing them now bloats the base image every ori forks
  from and contradicts the "thin base, injected extras" snapshot model (findings #10/#12).
- **deno / pnpm**: bun covers the JS runtime and its own package manager; adding more is
  speculative flexibility for v1.
- **Sunshine / WebRTC 60fps desktop**: v1 desktop is VNC (locked decision §2). Sunshine is
  backlog (P13).

Every deliberate shortcut in code carries a comment starting with the word **ponytail** naming
the ceiling and the upgrade path (see `provision.sh` and `manifest.md` for the arm64 Chrome one).

## Where the guest agent gets injected

`provision.sh` creates only a placeholder: directory `/opt/ori/guest-agent/` plus a systemd unit
`ori-agent.service` that is **not enabled** and has `ConditionPathExists=/opt/ori/guest-agent/ori-agent`.

- **Docker driver (P4-07):** copies the compiled agent binary into `/opt/ori/guest-agent/ori-agent`
  at container start (or into the image), writes `ORI_AGENT_PRESENT=1` into `/etc/ori.env`,
  `systemctl enable --now ori-agent`.
- **Incus (P12):** the image build (or driver) injects the binary the same way before first use,
  then `systemctl enable --now ori-agent`.

The agent exposes `:7777` (EXPOSE 7777 in the Dockerfile), reachable from the control plane
only (P6 firewall rule).
