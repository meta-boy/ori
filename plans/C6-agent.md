# C6 — `ori-agent`: guest agent

**You own:** `crates/ori-agent/**`. Nothing else.

Read: `docs/ARCHITECTURE.md` (Access paths), `docs/SPEC-CLI.md`
(`ori exec` flags are the contract).

Runs inside every sandbox. Linux-only (`#[cfg(target_os = "linux")]`), static
musl target, small binary — it gets baked into the golden image.

## Deliver

1. **Outbound tunnel to the control plane.** The sandbox opens the connection;
   the control plane never dials in. No inbound listening port on the sandbox.
   WebSocket over TLS is fine. Reconnect with jittered backoff — a reconnect
   storm from a few hundred sandboxes after a control-plane restart is a real
   outage, so the jitter is not decoration.

2. **`exec`** matching `ori exec`: `--cwd` (relative to the sandbox work dir),
   `--timeout` (1–600, default 30), streamed stdout/stderr, and the **remote
   exit code propagated** — the CLI exits with it. Target ≤1 s round trip
   (measured floor 0.90 s).

3. **`--detach`** — spawn detached, return a process id, log to
   `~/.ori/processes/<pid>.log`. `--status <pid>` returns running state, exit
   code, and a tail of the log. A pid the agent no longer knows about reports
   `lost` rather than an error — the agent may have restarted under it.

4. **Config injection** — apply env vars, secret files, and repo checkouts
   handed over at claim time. Secret files land 0600, owned by the sandbox user,
   and never in a world-readable temp path on the way there.

5. **`host <port>`** — register a port with the control plane for reverse
   proxying, and report whether anything is actually listening on it. Note for
   the message you return: a service bound to `127.0.0.1` will not be
   reachable; it must bind `0.0.0.0`. That is the single most common user error
   with this feature — detect it and say so, do not just hand back a URL that
   404s.

6. **Setup script** — run the `--setup-file` payload (max 64 KB) in the
   background after ready, and report `setupStatus`
   (`pending|running|done|failed`) + `setupError` to the control plane.

## Done means

`cargo test -p ori-agent` covering: exit-code propagation, timeout enforcement,
detach→status→lost lifecycle, secret-file permissions are 0600. Plus a manual
smoke run inside a real LXC documented in the crate README.

Do not implement SSH here — the control plane proxies to the guest `sshd`,
which stays bound to loopback.
