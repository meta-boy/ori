# C13 — multiplexed streams + PTY in the guest agent

**You own:** `crates/ori-agent/`. Extend the existing `Incoming`/`Outgoing`
frame protocol in `wire.rs`; do not redesign it.

`ssh`, `scp`, `forward`, `host` and `desktop` are not five features. They are
**one multiplexed byte-stream primitive** plus thin clients. Build the primitive.

## Frames to add

```
StreamOpen  { id, kind: Pty { cmd, cols, rows } | Tcp { port } | File { path, mode } }
StreamData  { id, bytes }        // binary WS frames, not base64 in JSON
StreamClose { id, code }
Resize      { id, cols, rows }
```

- **`Pty`** — allocate a real pty (`openpty`/`forkpty`; `portable-pty` or `nix`).
  A real pty is required, not a pipe: it is what makes job control, line
  editing, colours, `vim` and `top` work, and it makes Ctrl-C free (the pty layer
  turns the byte into SIGINT). `Resize` issues `TIOCSWINSZ`.
- **`Tcp`** — dial `127.0.0.1:port` inside the sandbox, relay bytes both ways.
  One stream per TCP connection.
- **`File`** — read or write a path, streamed. Directories are tar over the same
  stream. Enforce the sandbox work dir as the root; reject traversal.

## Rules

- **Backpressure is not optional.** A `cat` of a large file or a busy TCP forward
  will outrun the socket. Bound each stream's buffer and stop reading the source
  when it fills, rather than growing unboundedly and killing the agent — which
  takes every other stream on that tunnel with it.
- Stream ids are per-tunnel and must be cleaned up on close, on process exit, and
  on tunnel reconnect. A leaked pty is a leaked process.
- One slow or wedged stream must not block the others (independent tasks, not a
  shared select loop that can head-of-line block).
- Binary frames for `StreamData`. Base64-in-JSON would inflate every byte ~33%
  on the hot path.

## Done means

`cargo test -p ori-agent` green, plus tests for: pty echo round-trip, resize
taking effect (`stty size` inside the pty), tcp relay against a local listener,
file round-trip including a directory, traversal rejection, and a backpressure
test that pushes more than the buffer and asserts memory stays bounded.
