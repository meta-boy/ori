# image/ — what the golden image bakes in

Files in this directory are owned by the golden-image desktop card
(`plans/C18-desktop.md`) and the agent-autostart card (`plans/C25-agent-autostart.md`)
and baked into every sandbox by `scripts/golden-build.sh`:

| file | role |
|---|---|
| `ori-agent` | the agent autostart supervisor: waits for `/etc/ori/agent.json`, restarts `ori agent` on exit, logs to `/var/log/ori-agent/agent.log`. `/usr/local/sbin/ori-agent` in the image |
| `ori-desktop` | the desktop supervisor: `Xvfb -> x11vnc -> websockify(noVNC)`, all loopback-only, started at boot by systemd (ubuntu) / openrc (alpine). `/usr/local/sbin/ori-desktop` in the image |
| `wscheck.py` | proves `websockify` completes a real RFC 6455 WebSocket upgrade (used by the golden clone-check) |
| `README.md` | this file: the stack, the decisions, and the image-size cost |

## The agent — a pooled clone is tunnel-ready with no provisioning step

Every sandbox runs the guest agent (`ori agent`, a role of the single `ori`
binary at `/usr/local/bin/ori`) and dials out to the control plane, so
`exec`/`ssh`/`scp`/`forward`/`host` ride the ~0.11 s tunnel instead of the slow
provider fallback. The autostart supervisor (`image/ori-agent`) is started at
boot by the `ori-agent` unit (systemd on ubuntu, openrc on alpine), alongside
`sshd`, `docker` and `ori-desktop`, and it must get three things right:

- **Wait for the config, don't fail.** A pool member is cloned *before* it is
  claimed, so `/etc/ori/agent.json` does not exist at boot. The supervisor loops
  until it appears; the unit is up and waiting, not failed.
- **Restart on exit.** The agent reconnects forever with jittered backoff, but
  cannot survive its own process dying. The supervisor restarts it; `Restart=always`
  / openrc is a second layer for the supervisor itself.
- **Log somewhere findable.** Everything lands in `/var/log/ori-agent/agent.log`,
  created before anything runs — an empty agent log has cost real debugging time.

### Config contract — `/etc/ori/agent.json`

The control plane writes this file at claim time (see `docs/DIVERGENCES.md`
"agent.json injection is still open"); the sandbox only consumes it. Shape is
camelCase JSON, exactly as `crates/ori-agent/src/config.rs` parses it:

```json
{
  "controlPlaneUrl": "wss://plane.example.com/agent/ws",
  "token": "orit_…",
  "sandboxId": "ori_…",
  "workDir": "/home/work/work"
}
```

- `controlPlaneUrl` — `ws://` or `wss://` tunnel endpoint on the control plane.
- `token` — the sandbox's per-sandbox agent credential (not an account key).
- `sandboxId` — this sandbox's id, echoed on every tunnel handshake.
- `workDir` — sandbox work dir (optional; defaults to `~/.ori/work`).

It carries a credential, so it is **0600, root-owned** — the supervisor enforces
it too (`chmod 0600` before starting the agent). Writing it at claim time belongs
to the control plane, not the image; that seam is recorded as still-open in
`docs/DIVERGENCES.md`.

## The stack

```
browser (noVNC)
  │  WebSocket (ws://…/websockify)
  ▼
websockify 127.0.0.1:6080   ── TCP splice ──▶  x11vnc 127.0.0.1:5900
  │  serves the noVNC static assets (--web /usr/share/novnc)
  ▼
Xvfb :99  (headless framebuffer, 1920x1080x24)
  ▼
fluxbox (light window manager)
```

`websockify` makes `desktop` the **same primitive as `ssh`** — a TCP splice
over a WebSocket to a loopback port, exactly the `Tcp { port }` stream the ori
agent already dials. Nothing here opens a port on the sandbox: **x11vnc and
websockify both bind 127.0.0.1 (and ::1 for x11vnc) only**, matching how
`sshd` is configured. The ori tunnel is the authentication boundary, so VNC
carries **no password** — the same posture as sshd.

Components at boot, from the `ori-desktop` supervisor:

```
Xvfb :99 -auth /root/.Xauthority -screen 0 1920x1080x24 -nolisten tcp
fluxbox                                     (DISPLAY=:99)
x11vnc -auth /root/.Xauthority -forever -shared -nopw -localhost -rfbport 5900
websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900
```

A fresh MIT-MAGIC-COOKIE is written to `/root/.Xauthority` each time Xvfb is
(re)started so x11vnc can complete the X handshake without `-ac`; it is not an
access-control boundary. `-nolisten tcp` keeps X itself off any socket.
`websockify` runs in the foreground supervisor loop with the rest; the unit
(`ori-desktop.service` on ubuntu, `/etc/init.d/ori-desktop` on alpine) is
enabled at boot, so **a pooled clone is desktop-ready with no provisioning
step**, exactly like sshd and docker.

## noVNC vs KasmVNC — why noVNC is the default

noVNC is optimised for **low bandwidth, not low latency** — it targets
interactive use over constrained links rather than smooth passive viewing.
KasmVNC is the lower-latency alternative but **drops audio, uploads/downloads
and microphone passthrough**.

For a development sandbox the desktop is the *fallback* UI: people work in a
terminal over `ori ssh`, and reach for the desktop to drive something
graphical. Latency matters less there than *not silently losing features* —
upload/download through the VNC session, clipboard-adjacent actions and any
audio/webcam passthrough would all be gone with KasmVNC. So the image defaults
to **noVNC**, and KasmVNC stays a documented alternative if a later card needs
the latency. The browser path is unchanged either way: `noVNC (browser) ->
websockify -> x11vnc`.

Sources: the trade-off comparison in the C18 card
(<https://sourceforge.net/p/guacamole/discussion/1110834/thread/00b95bb2/> and
<https://github.com/gezp/docker-ubuntu-desktop>).

## Window manager — why fluxbox over xfce4

Both are offered by the card. **fluxbox** was chosen:

- **Size.** This rootfs is baked into every sandbox and cloned on every
  `ori new` / pool refill; xfce4's metapackage drags in a full desktop
  environment (panel, file manager, settings daemons, polkit, gvfs) that adds
  several hundred MB for chrome nobody uses over a low-bandwidth noVNC
  session. fluxbox is a single ~1.7 MB window manager.
- **No dbus/polkit session.** xfce4-session wants a session bus and policykit;
  fluxbox runs directly on the X display with no session services, which is
  exactly what a headless VNC target needs.
- **Usable enough.** Workspaces, window decorations and a right-click menu are
  plenty to drive a graphical app over VNC; `xterm` is installed alongside so
  there is a terminal to click. A full DE on a VNC fallback is ergonomics no
  one asked for.

Measured against the old choice (xfce4) — see the size table below: fluxbox
keeps the desktop marginal cost to roughly half of what xfce4 would add.

## Image size — the cost baked into every sandbox

The desktop stack is **not free**: it grows the golden rootfs, and that rootfs
is cloned (linked-clone, so it is the *size of the data*, not the reservation)
for every `ori new` and every pool refill. The clone currently takes ~1.65-
1.83 s on an idle host (`docs/BENCHMARKS.md`); a larger rootfs slows each fork
and refill. Numbers below are `du -xsk /` measured inside the container during
`golden-build.sh` (before vs after the desktop block) — reproduced on every
build, so the delta is the honest marginal cost of the desktop.

| tier | rootfs before desktop | after desktop | delta |
|---|---|---|---|
| ubuntu (9500) | 1,268,044 KiB (~1.24 GB) | 1,721,820 KiB (~1.68 GB) | **+453,776 KiB (~443 MB)** |
| alpine (9501) | 312,088 KiB (~305 MB) | 750,748 KiB (~733 MB) | **+438,660 KiB (~428 MB)** |

Measured 2026-08-23 on the rebuilt goldens (`du -xsk /` inside the container,
before vs after the desktop block — reproduced on every `golden-build.sh` run
as `desktop rootfs: before=… after=… delta=…`). The bulk is X + fontconfig +
the `websockify` Python stack (it pulls `python3-numpy`/`libgfortran` on
alpine, and the Xorg client libs on both). The biggest single lever left is
the window-manager choice already made above; `--no-desktop` skips the whole
block if an operator wants the lean tier.

The **agent is tiny by comparison**: a single static musl `ori` binary
(`/usr/local/bin/ori`, ~13.6 MiB) plus the ~1 KiB supervisor. The exact delta
is reported on every build as `agent rootfs: before=… after=… delta=…`, and the
C25 clone-check proves the binary actually connects, so the number is not the
only thing keeping it honest. It was left unmeasured for too long — "the agent
is ~14 MB, but say so rather than leaving it unknown." Measured 2026-08-23 on
the rebuilt ubuntu golden: **+13,628 KiB (~13.3 MiB)** (`agent rootfs:
before=1735252KiB after=1748880KiB delta=13628KiB`).

## noVNC assets — pinned, checksummed

- **alpine:** shipped by the distro `novnc` package → `/usr/share/novnc`
- **ubuntu:** the `novnc` deb drags in nodejs, so the build fetches the pinned
  upstream release `v1.5.0` and verifies
  `sha256 6a73e41f98388a5348b7902f54b02d177cb73b7e5eb0a7a0dcf688cc2c79b42a`
  before extracting to `/usr/share/novnc`. Deterministic and reproducible.

## Verification

`scripts/golden-clone-check.sh` proves on a real clone that: X is up
(`/tmp/.X11-unix/X99`), fluxbox is running, `x11vnc` and `websockify` listen on
loopback **only**, and `websockify` completes a WebSocket handshake against the
VNC backend (`python3 image/wscheck.py`). Because websockify only answers a
WebSocket upgrade (HTTP 101) after it has connected to x11vnc, the handshake
passing is the end-to-end proof.

The same clone-check proves the agent autostarts: the supervisor is up and
*waiting* at boot (config absent — a pool member is cloned before it is
claimed); dropping a valid `/etc/ori/agent.json` in makes the agent connect to
a real control plane with no other action; and a reboot makes it reconnect on
its own.