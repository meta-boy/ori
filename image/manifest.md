# Base image preinstall manifest — ori-image

Source of truth for `image/provision.sh`.

**This is no longer a v1 subset.** The image now carries the Budgie desktop and the full polyglot
toolchain rather than a minimal subset. Two tiers:

| `ORI_IMAGE_TIER` | Contents | Size | Build |
|---|---|---|---|
| `core` | base tools + the desktop | ~4 GB | ~10 min |
| `full` (default) | + every runtime, editor and terminal-graphics tool below | ~9 GB | ~25 min |

CI, the e2e suites and local iteration only ever need `core`. A build flag beats two divergent
Dockerfiles.

## The desktop

| Piece | What | Why it is this and not something else |
|---|---|---|
| `budgie-desktop` 10.9.1 | the DE | this image runs Budgie, not XFCE or GNOME. `budgie-wm` wraps mutter |
| `nemo` + `nemo-desktop` | "Files", **and the desktop icons** | Budgie draws no desktop icons at all. `nemo-desktop` from `~/.config/autostart` plus `org.nemo.desktop show-desktop-icons=true` is what paints them — both are required, and without them you get a wallpaper and nothing else |
| `gnome-terminal` / `gnome-control-center` | "Terminal" / "Settings" | These are the launchers on the desktopop, not Budgie's own |
| `plank` | the dock | Installed in this image |
| `ghostty` | terminal | From `mkasberg/ghostty-ubuntu`'s `.deb`. Ghostty's docs are explicit that the project ships prebuilt binaries for **macOS only**; every Linux binary is community-maintained. Assets exist for both `amd64_24.04` and `arm64_24.04`, so unlike Chrome this is not an amd64-only gap. Snap needs snapd and AppImage needs FUSE — both wrong in a container |
| `lightdm` (**masked**) | — | the session autologins through LightDM into Budgie. A container has no VT for LightDM to drive, so `budgie-session.service` does the autologin's job instead |
| `xvfb` serving `:99` | the X server | this image runs a real Xorg with the `dummy` driver. `xserver-xorg-video-dummy` and the ori's own `10-virtual-display.conf` are installed ready for the VM path (P12); what Xvfb costs is RANDR resolution changes |

### `XDG_RUNTIME_DIR` — the fix worth knowing about

`budgie-session.service` sets `XDG_RUNTIME_DIR=/run/user/%U` and creates the directory. Its absence
fails **silently and completely**: systemd reports the unit `active`, `budgie-desktop` starts, and
nothing appears — no panel, no window manager, no desktop icons — because every GNOME-lineage
component keeps its sockets under it and gives up quietly when it is unset. Found by running
`budgie-desktop` by hand and diffing the environment against the unit's.

### Masked units

Installing a desktop enables a pile of services that then fail for want of hardware — ModemManager,
udisks2, colord, cups, tpm-udev. Two consequences, both of which happened: systemd settles at
`degraded` forever, and boot slows to a crawl waiting on each one. `provision.sh` masks them.
Masking, not disabling: a desktop-session dependency can pull a merely-disabled unit back in.

Related and worth stating: the Docker driver's readiness check must accept `degraded`.
`systemctl is-system-running` exits **non-zero** for `degraded`, so a check that requires exit 0
can never accept it, and every ori fails to provision with "systemd not ready".

| Package | Why / provenance | Pin |
|---|---|---|
| `openssh-server` | `user` reachable over sshd (P7); the ori's primary dev surface | distro (stable) |
| `docker.io` | dockerd runs *inside* the ori (Docker driver runs `--privileged`) | distro (stable) |
| `restic` | the snapshot engine (locked decision §2). State = object storage, no hand-rolled dedup | distro (stable) |
| `tmux` | P9: prompt/harness runs in a tmux pane so we can interrupt and tail it | distro |
| `curl` | universal HTTP tool inside the ori + guest agent self-checks | distro |
| `git` | version control, and P9 `git_checkpoint` auto-commit each turn | distro |
| `gh` | GitHub CLI | pinned latest release from GitHub |
| `ripgrep` (`ripgrep` pkg) | `rg`; fast file search | distro (stable) |
| `jq` | JSON at the CLI | distro |
| `ffmpeg` | desktop streaming fallback + media primitives | distro (stable) |
| `build-essential` | `gcc`/`g++`/`make` for compiling agents' C-adjacent deps | distro |
| `cmake` | alongside build-essential; restart-of-world builds (`gcc/clang/cmake`) | distro |
| `node` via **nodesource** `20.x` | node; nodesource LTS listed explicitly rather than distro because older but fairly recent LTS is required by many agent CLIs and the distro copy lags | version-agnostic most-recent LTS at build time (`20` repo line) |
| `bun` | the whole stack runs on Bun (locked decision §2); guest agent is a Bun binary | latest stable via the official installer script (pinned by curl check) |
| `python3` + `pip` + `venv` | agent SDKs are python-generated (PyPI `the upstream Python SDK`) | distro (python3 is 3.12 on 24.04) |
| `uv` | python package/env manager | pinned latest release from GitHub |
| `go` | host/guest tools written in Go | distro (`golang`) |
| `rustup` | `rust`; rustup-managed, so the toolchain stays user-floatable | distro `rustup` (thin installer) |
| `google-chrome-stable` | headless browsing + desktop (P8) | **architecture-dependent — see below** |
| `xvfb`, `x11vnc` | VNC desktop fallback (P8 locked decision §2); systemd units, **not enabled**, start lazily | distro |
| `novnc` + `websockify` | browser VNC client (P8, `--vnc` path) | distro |
| `openori` | window manager. Without one the desktop is a bare X root: windows get no decorations and cannot be moved, resized, raised or closed, so a GUI ori is unusable. Verified over VNC. **Not labwc**, which the plan names — labwc is a Wayland compositor and this stack is X11 (Xvfb + x11vnc), so it cannot manage these windows at all | distro |
| `xterm`, `x11-apps` | something to actually launch. The only other GUI binary here is chromium, which on arm64 is a snap wrapper that cannot start until first boot hydrates it — so without xterm a correctly-working desktop still looks broken | distro |
| *guest agent binary* | placeholder ** drop point**; injected at build/runtime by P4-07 docker driver and P12 incus image, not by provision.sh | n/a |

## Architecture note: `google-chrome-stable`

`google-chrome-stable` publishes **no arm64 Linux package** (only amd64 .deb). This build machine is
arm64 macOS running Docker (platform `linux/aarch64`), so a naive `apt install google-chrome-stable` would
kill the build.

```
ponytail — ceiling: no arm64 Google Chrome. Upgrade path: swap to the official
google-chrome-stable .deb once Google ships arm64 Linux; keep chromium as the arm64
fallback. The desktop path (P8) works headless on either via `--headless=new`.
```

Policy implemented in `provision.sh`:
- amd64 (`linux/amd64`): install `google-chrome-stable` from the Google repo (does not exist here, so it is
  the branch that is exercised on real hosts).
- arm64 (`linux/aarch64`): install the distro `chromium-browser` (snapless `chromium` package) and symlink
  `google-chrome-stable` → chromium so any downstream tool asking for the Chrome binary resolves.

## The `full` tier

Runtimes: `default-jdk maven gradle`, `ruby-full` + bundler, `php` + composer, `elixir`/`erlang`,
`r-base` (from CRAN, because the distro copy lags), `dotnet-sdk`, `kotlin` and `scala`/`sbt` (tarballs
— neither is an apt package). Editors: VS Code. Terminal graphics: `chafa` (the good one — truecolor,
sixel and kitty protocols), `caca-utils`, `jp2a`, `libsixel-bin`, `w3m`+`w3m-img`, `neofetch`,
`toilet`/`figlet`, `imagemagick`. Android: `adb`, `fastboot`, `scrcpy`. Desktop automation: `xdotool`,
`wmctrl`, `xsel`, `xclip` — this image runs an `xdotool-server.service`, which is how `lux` drives
the GUI.

apt repositories added, namely: CRAN, Microsoft (dotnet),
VS Code, Google Chrome, nodesource, github-cli, docker, ondrej/php.

One unavailable package must not lose the whole layer, so a bulk install failure falls back to
per-package with a `SKIPPED (unavailable on <arch>)` line — `code` is amd64-only in some releases and
elixir occasionally lags on arm64.

## Still excluded

- The agent CLIs (`claude`, `codex`, `lux`, `host`, `ori`). P9, and `lux` is theirs, not ours.
- `deno`/`pnpm`: bun already covers the JS runtime.
- `deno`/`pnpm`: bun (and its package manager) already covers the JS runtime; adding more is
  speculative flexibility for v1.
- Sunshine/WebRTC 60fps desktop: v1 is VNC (Xvfb+x11vnc+noVNC) per locked decision §2; Sunshine is backlog.

## Guest agent drop point

Nothing in the toolchain depends on the agent; the placeholder is a directory + env marker so the builders
know **where** to put it and **whether** it is present:

- Decoded path: `/opt/ori/guest-agent` (the binary itself lives at `/opt/ori/guest-agent/ori-agent`).
- Env marker: `ORI_AGENT_PRESENT=1` written to `/etc/ori.env` only when the binary is dropped in.
- systemd unit `/etc/systemd/system/ori-agent.service` is written but **not enabled**; the docker driver
  (P4-07) and incus image build (P12) enable and start it after injecting the real binary + token.

## Freshness

Run `image/build-incus.sh` / `docker build` from a clean cache to re-pull distro packages. `gh`, `uv`, and
`bun` are fetched at install time by their upstream installers; re-running the build refreshes them.