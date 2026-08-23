# C15 — `ssh`, `scp`, `forward` over the tunnel

**Owns the seam:** a user on a laptop runs `ori ssh <id>` and gets a shell in a
sandbox that has no inbound port open.

## The design — do not reimplement SSH

The CLI does **not** speak the SSH protocol. It hands off to the system `ssh`
with a `ProxyCommand` that relays stdio over a WebSocket to the control plane,
which splices those bytes to the sandbox's own `sshd`. Real SSH runs end to end
inside that pipe.

Why this shape rather than a pty in the guest agent:

- **SSH's cryptography stays end to end.** The tunnel is transport; it
  authenticates *access to the machine* and never sees the session.
- **`scp`, `rsync`, `git` over ssh, VS Code Remote-SSH and JetBrains remote all
  work for free**, because it is genuinely SSH. A hand-rolled pty protocol gets
  none of them.
- **`sshd` stays bound to loopback.** Nothing new is exposed, and the golden
  image already ships it that way.
- It works through any HTTPS reverse proxy that passes WebSockets, which is how
  a self-hosted control plane is usually reached.

## Build

1. **`GET /api/v1/sandboxes/{id}/ssh-tunnel`** — WebSocket. Authenticate with the
   API key. Accept the token **as a query parameter as well as a header**: a
   WebSocket opened from a browser cannot set headers, and the dashboard will
   want the same endpoint.
2. **Splice** the socket to the sandbox's `sshd`. Prefer routing through the
   agent's `Tcp` stream (`plans/C13`) to port 22 — the agent dials outward, so
   the control plane needs no route to the sandbox network. Fall back to a direct
   TCP connection to the sandbox IP where a route exists.
   **Buffer bytes the client sends before the far end finishes connecting** —
   `ssh` starts talking immediately and those first bytes are the version
   exchange. Dropping them hangs the session.
3. **`POST /api/v1/sandboxes/{id}/sshkey`** — authorize a public key on the
   sandbox. Append-only, idempotent, and it must not clobber existing keys.
4. **CLI**: ensure an ed25519 keypair (`ssh-keygen`, empty passphrase, 0600),
   authorize the public half, then exec the system `ssh` with
   `ProxyCommand ori ssh --stdio <id>`. Add the hidden `--stdio` relay
   subcommand. Set `StrictHostKeyChecking`/`UserKnownHostsFile` deliberately so
   a recycled sandbox id does not produce a host-key warning — decide and
   document which, rather than leaving ssh to prompt.
5. **`scp` and `forward`** are the system tools with the same ProxyCommand.
   `forward` is `ssh -L`, or the agent `Tcp` stream directly.
6. **Wake-on-connect**: connecting to a stopped sandbox resumes it and waits for
   ready, printing one line to stderr, instead of failing with "not running".
   Bound the wait and fail clearly if it never becomes ready.

## Done means — verified against the real host

- `ori ssh <id>` gives an interactive shell in a real LXC on the Proxmox host,
  with a working pty (`vim`, `top`, Ctrl-C, window resize all behave).
- `ori ssh <id> -- uname -a` returns the right output and the **remote exit code**.
- `ori scp` moves a file both directions, and `-r` a directory.
- `ori forward --remote <port>` serves a real listener inside the sandbox.
- `ssh` against a **stopped** sandbox resumes it and connects.
- Record in `docs/STATUS.md` which of these now work, replacing their stub rows.

A mock-tunnel unit test does not satisfy this card.

## Verified facts about the golden image (do not re-derive)

Measured on a fresh linked clone of golden 9501 on the project's host:

- `sshd` **is** running and bound **loopback-only**: `127.0.0.1:22` and `::1:22`.
  Process is `sshd: /usr/sbin/sshd [listener]`. Confirmed with `nc -z`.
- There is an unprivileged `work` user (uid 1000, home `/home/work`,
  shell `/bin/sh`). Authorize keys for that user, not root — `sshd_config` ships
  the distro default `PermitRootLogin prohibit-password`.
- `rc-status` shows `sshd`, `docker`, `crond`, `networking` all started at boot,
  so a pooled clone is ssh-ready without provisioning.

**Probe tooling warning.** This container is busybox-based:

- `ss` is **not installed**; `netstat` exists but does **not** support `-p`, so
  `netstat -tlnp` fails outright.
- `/dev/tcp/...` does **not** work — busybox `sh` has no such feature, so a
  `(echo > /dev/tcp/host/port)` test reports failure unconditionally.

Both of those produced a confident false negative ("no sshd") during
investigation. Use `nc -z -w2 127.0.0.1 22` or plain `netstat -tln`, and prefer
a positive test over a fallback chain that reports absence when the tool is
missing.
