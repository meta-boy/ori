# `ori-agent` — the guest agent

Runs inside every sandbox. Opens an **outbound** WebSocket to the control plane
(the plane never dials in; the sandbox exposes no inbound port) and serves
`exec`, `--detach`/`--status`, `host <port>`, claim-time config injection, and
the setup script.

Part of the single `ori` binary (`crates/ori-cli` wires `ori agent` to
`ori_agent::run`). Linux-only at runtime; the crate compiles everywhere so
`cargo test -p ori-agent` runs on a developer machine.

## What it does

| Concern | Behaviour |
|---|---|
| Tunnel | Outbound WebSocket (`ws://`/`wss://`) to `controlPlaneUrl`. Reconnects forever with **full-jitter exponential backoff** (`backoff.rs`): after a plane restart a few hundred sandboxes all wake at once, and a fixed delay turns that into a reconnect storm. |
| `exec` | `cmd` argv, `--cwd` (relative to the sandbox work dir unless absolute), `--timeout` (1–600 s, default 30), request-scoped `env`. stdout/stderr are **streamed** as `stream` frames as they arrive and aggregated in the terminal `execResult`; the **remote exit code propagates** (timeout kills the process group and reports 124; signal deaths report `128 + signal`). |
| `--detach` | Spawns in its own process group, logs to `~/.ori/processes/<pid>.log` (0600), returns the pid. `--status <pid>` returns `running|exited|lost` plus the exit code and a log tail. A pid the agent no longer knows reports **`lost`** (the agent may have restarted under it), never an error. |
| Config injection | Env vars, secret files, repo checkouts handed over at claim time. Secret files land at their **final path with mode 0600**, owned by the sandbox user, **never through a world-readable temp file** (`inject.rs`). A failed secret write fails the whole claim. |
| `host <port>` | Probes the port and reports whether anything is listening, and whether it is **loopback-only**. A service bound to `127.0.0.1` is the most common `ori host` mistake: it registers fine, the URL mints fine, and then it 404s. The agent detects that from `/proc/net/tcp[6]` and says so instead of hand-waving. |
| Setup script | Runs the ≤ 64 KiB `--setup-file` payload in the background after the claim applies, reporting `setupStatus` (`pending → running → done|failed`) and `setupError` (a log tail on failure) to the plane. |

No SSH anywhere. `exec` is a direct `spawn` over the tunnel; the SSH path that
`pct exec` uses (measured 2.7 s round trip, 0.90 s for SSH alone) is only the
bootstrap fallback the *control plane* uses before the agent is up.

## Wire protocol (the contract for the control plane)

One JSON object per WebSocket text frame, tagged by `"type"`, camelCase fields.
Shapes are defined in `src/wire.rs`; the plane side (another crate) implements
against this.

```text
agent ──> plane   {"type":"hello","sandboxId":"ori_x","hostname":"…","version":"…","pid":123}
plane ──> agent  {"type":"apply","id":"…","env":{…},"secretFiles":[{"path":…,"contentsB64":…}],
                  "repos":[{"url":…,"ref":"main","path":…}],"setup":{"scriptB64":…}}
plane ──> agent  {"type":"exec","id":"…","cmd":["sh","-c","curl …"],"cwd":"src","timeout":30,
                  "env":{…},"detach":false}
agent ──> plane  {"type":"stream","id":"…","fd":1,"dataB64":…}        (0..n)
agent ──> plane  {"type":"execResult","id":"…","pid":42,"completed":true,"exitCode":7,
                  "durationMs":123,"timedOut":false,"detached":false,"stdout":"…","stderr":"…"}
plane ──> agent  {"type":"execStatus","id":"…","pid":42}
agent ──> plane  {"type":"execStatusResult","id":"…","state":"running|exited|lost",
                  "exitCode":…,"logTail":"…"}
plane ──> agent  {"type":"host","id":"…","port":3000,"public":false}
agent ──> plane  {"type":"hostResult","id":"…","listening":true,"loopbackOnly":true,
                  "note":"service is bound to 127.0.0.1 … rebind it to 0.0.0.0"}
agent ──> plane  {"type":"applyResult","id":"…","ok":true,"error":null}
agent ──> plane  {"type":"setupStatus","status":"running|done|failed","error":null}
agent ──> plane  {"type":"ack"|"error",…}
```

Contract notes for the plane:

- Authentication is a `Authorization: Bearer <token>` header plus
  `x-ori-sandbox` on the upgrade; the plane should reject unknown tokens and
  bind the connection to the sandbox id in the `hello` frame.
- The CLI exits with `execResult.exitCode`; a `spawn`/`invalid_request` error
  frame means the call failed, not the command. A timed-out command reports
  `timedOut:true` and exit code 124 (GNU `timeout` convention).
- `hostResult` **is** the registration: the plane sets up the reverse proxy and
  must act on `loopbackOnly` (do not hand back a URL that 404s).
- `setupStatus` maps onto the sandbox's `setupStatus`/`setupError` fields.

## Config

`ori agent --config <path>` (or `ORI_AGENT_CONFIG`, or `/etc/ori/agent.json`,
then `~/.ori/agent.json`). The provisioning writes this file at claim time;
it carries secret material, so the agent re-chmods it to 0600 on load.

```json
{
  "controlPlaneUrl": "wss://plane.example.com/agent/ws",
  "token": "…",
  "sandboxId": "ori_a1b2c3d4",
  "workDir": "/home/user/work",
  "claim": {
    "env": { "CI": "true" },
    "secretFiles": [{ "path": "/home/user/.netrc", "contentsB64": "…" }],
    "repos": [{ "url": "https://git.example.com/org/repo", "ref": "main", "path": "repo" }],
    "setup": { "scriptB64": "…" }
  }
}
```

The config claim is applied at boot (before the tunnel serves anything — a
sandbox with missing secrets must never come up as `ready`). The same payload
can be pushed live with an `apply` frame; the setup script starts only once a
tunnel exists to report over.

## Build

Small static binary — the agent is baked into every sandbox image.

```bash
# Add the musl target once
rustup target add x86_64-unknown-linux-musl
# The full `ori` binary for a Linux sandbox (agent role included):
cargo build --release --target x86_64-unknown-linux-musl -p ori-cli
# TLS is rustls-on-ring (no OpenSSL), so static linking is clean.
```

Dependency policy: `tokio` + `tokio-tungstenite` (rustls) + `serde` +
`base64` + `libc` only. Deliberately **no** `ori-providers` (a Proxmox HTTP
client has no business inside a sandbox) and no `rand` (the backoff uses a
tiny in-crate xorshift).

## Tests

```bash
cargo test -p ori-agent
```

Covers the four required behaviours plus the surrounding machinery:

- exit-code propagation (`exit 42` → `42`), timeout enforcement (kills the
  process group, reports 124, returns fast), signal-death mapping (`128+sig`),
  spawn failures surfaced as errors, cwd resolution, streamed output.
- `--detach` → `--status` → `lost` lifecycle, per-pid 0600 logs, log tails.
- secret files land exactly 0600 (and a loose pre-existing file is tightened),
  bad payloads fail the claim, nothing half-applies.
- `host` against a real listener and a closed port.
- setup script `done` / `failed` (with `setupError`) and the 64 KiB cap.
- backoff growth, full-jitter bounds, determinism; procfs bind-address parsing.

## Manual smoke run inside a real LXC

Before the control-plane tunnel endpoint exists, drive the agent against a
throwaway WebSocket server. On a Proxmox host:

```bash
# 1. Build the agent binary for the container's arch and copy it in.
cargo build --release --target x86_64-unknown-linux-musl -p ori-cli
pct push <vmid> target/x86_64-unknown-linux-musl/release/ori /usr/local/bin/ori

# 2. Write the agent config inside the container.
pct exec <vmid> -- sh -c 'mkdir -p /etc/ori && cat > /etc/ori/agent.json <<EOF
{
  "controlPlaneUrl": "ws://10.0.0.5:9090/agent/ws",
  "token": "dev",
  "sandboxId": "ori_smoke01",
  "workDir": "/root/work",
  "claim": {
    "env": {"SMOKE":"1"},
    "secretFiles": [{"path":"/root/.smoke-secret","contentsB64":"c21va2U="}],
    "setup": {"scriptB64":"ZWNobyBzZXR1cC1vayA+IC9yb290L3NldHVwLmxvZw=="}
  }
}
EOF'

# 3. Run a tiny WebSocket control-plane stand-in on the host (Python 3.9+ with
#    `pip install websockets`) that echoes frames — see below.

# 4. Start the agent and drive it by hand.
pct exec <vmid> -- ori agent
#   In another shell, watch the frames the mock plane prints, then send:
#   {"type":"exec","id":"e1","cmd":["sh","-c","exit 7"],"timeout":30}
#   → stream/execResult frames with exitCode 7. The CLI contract: `ori exec`
#     would exit 7.
```

Mock control-plane stand-in (`mock-plane.py`):

```python
import asyncio, websockets

async def handler(ws):
    async for raw in ws:
        print("plane <=", raw)                 # hello, applyResult, setupStatus, …
        # reply with an exec that proves the pipeline:
        await ws.send('{"type":"exec","id":"e1","cmd":["sh","-c","echo hi; exit 7"],"cwd":"..","timeout":30,"env":{"X":"1"},"detach":false}')

async def main():
    async with websockets.serve(handler, "0.0.0.0", 9090):
        print("mock plane on ws://0.0.0.0:9090")
        await asyncio.Future()

asyncio.run(main())
```

Checklist for a passing smoke run:

- `hello` arrives with the right `sandboxId`; the tunnel stays up across a
  plane restart (kill the mock, watch the backoff, restart it, see `hello`
  again).
- `secretFiles` lands at `/root/.smoke-secret` with mode `0600`
  (`stat -c %a /root/.smoke-secret` → `600`).
- `exec` streams `hi`, then `execResult` with `exitCode 7`.
- `exec` with `"detach":true` returns a pid; `execStatus` on it goes
  `running` → `exited`; `execStatus` on a bogus pid returns `"state":"lost"`.
- `setupStatus` reaches `done` and `/root/setup.log` contains `setup-ok`.
- `host` against a service on `127.0.0.1` reports `loopbackOnly:true` with the
  rebind note; against `0.0.0.0` reports `loopbackOnly:false`.

## Known limitations

- The setup script is started by whichever path supplies it first (config claim
  at connect, or an `apply` frame); a later, different payload is ignored.
- `wss://` trusts webpki roots only. A private-CA control plane should either
  use a public cert at a reverse proxy or run the agent on `ws://` inside the
  sandbox network. There is deliberately no "insecure TLS" escape hatch.
- No application-level heartbeat yet; a silently black-holed TCP connection is
  noticed on the next write and reconnects via the jittered backoff.
- Detached processes survive the agent dying (own process group, files stay
  open) but are then reported `lost` — which is the specified, honest answer:
  the agent cannot vouch for a pid after it restarted.
- The agent must run as the sandbox user, not root: secret files are created by
  whatever user the agent is, and "owned by the sandbox user" is exactly that.