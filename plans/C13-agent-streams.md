# C13 — TCP and file streams in the guest agent

**You own:** `crates/ori-agent/`. Extend the existing `Incoming`/`Outgoing`
frame protocol in `wire.rs`; do not redesign it.

**Scope note — no pty here.** An earlier draft of this card had the agent
allocate a pty for `ori ssh`. That is unnecessary: `ssh` is delivered by
splicing TCP to the sandbox's own `sshd` and letting real SSH run end to end
(see `plans/C15-ssh.md`), and `sshd` provides the pty, job control, and signal
handling itself. Reimplementing that in the agent would be strictly worse code
for a strictly worse result.

## Frames to add

```
StreamOpen  { id, kind: Tcp { port } | File { path, mode } }
StreamData  { id, bytes }        // binary WS frames, not base64 in JSON
StreamClose { id, code }
```

- **`Tcp`** — dial `127.0.0.1:<port>` inside the sandbox and relay bytes both
  ways, one stream per connection. This is the primitive behind `ori forward`,
  and it is also how the SSH splice reaches `sshd` **without the control plane
  needing a network route to the sandbox** — the agent dials outward, so nothing
  has to be routable inbound.
- **`File`** — read or write a path, streamed. Directories are tar over the same
  stream. Root every path at the sandbox work dir and reject traversal.

## Rules

- **Backpressure is not optional.** A large file or a busy forward will outrun
  the socket. Bound each stream's buffer and stop reading the source when it
  fills. Growing unboundedly kills the agent, which takes every other stream on
  that tunnel with it.
- One slow or wedged stream must not block the others — independent tasks, not a
  shared loop that can head-of-line block.
- Clean up stream state on close, on process exit, and on tunnel reconnect.
- Binary frames for `StreamData`; base64-in-JSON inflates every byte ~33% on the
  hot path.

## Done means

`cargo test -p ori-agent` green, plus: tcp relay against a local listener, file
round-trip including a directory, traversal rejection, and a backpressure test
that pushes more than the buffer and asserts memory stays bounded.
