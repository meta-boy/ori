# C18 — the graphical desktop

**You own:** the desktop stack in the golden image — `scripts/golden-build.sh`
provisioning, `image/`, `infra/`. Do not touch Rust crates; the CLI wiring is a
later card.

## The stack, and why this is not new plumbing

Research converges on one boring, well-trodden pipeline:

```
Xvfb (headless framebuffer) -> x11vnc (VNC server) -> websockify (TCP->WS) -> noVNC (browser)
```
<https://github.com/bopeng/ai-marketplace-monitor/issues/310>

The important consequence: **`websockify` means `desktop` is the same primitive
as `ssh`** — a TCP splice over a WebSocket to a loopback port. The `Tcp` stream
frame in `crates/ori-agent` already carries it. So there is no new transport to
build here; the work is baking the X stack into the image and picking a window
manager.

Keep everything bound to **loopback**, exactly as `sshd` is. Nothing about the
desktop should open a port on the sandbox.

## Trade-off to decide, not discover later

noVNC is optimised for low bandwidth, **not low latency** — it targets
interactive use over constrained links rather than smooth passive viewing.
KasmVNC is the lower-latency alternative but drops audio, uploads/downloads and
microphone passthrough.
<https://sourceforge.net/p/guacamole/discussion/1110834/thread/00b95bb2/> ·
<https://github.com/gezp/docker-ubuntu-desktop>

For a development sandbox, losing audio and clipboard-adjacent features probably
matters more than latency, so **default to noVNC** — but write the choice and
its reasoning into `image/README.md` so the next person does not rediscover it.

## Deliver

1. Provision `Xvfb`, a light window manager (xfce4 or fluxbox — pick one and say
   why), `x11vnc` bound to loopback, `websockify`, and `noVNC` static assets.
2. Start them at boot via the image's init, the same way `sshd` and `docker`
   already start, so a pooled clone is desktop-ready with no provisioning step.
3. Keep the image size increase visible: report before/after in
   `image/README.md`. This is baked into every sandbox, and the golden clone
   currently takes ~2.4 s — a much larger rootfs slows every `fork` and pool
   refill, so the cost is not free.
4. Verify on a real clone of the golden: X is up, the VNC port is listening on
   loopback only, and `websockify` serves a WebSocket that a client can complete
   a handshake against.

## Done means

`scripts/golden-clone-check.sh` gains desktop checks alongside its existing
sshd/docker/git/DHCP ones, passing on a real clone, plus the before/after image
size and the noVNC-vs-KasmVNC decision recorded.
