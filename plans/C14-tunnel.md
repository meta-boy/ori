# C14 — the tunnel seam: control plane ⇄ guest agent

**You own the seam, end to end.** Not "an endpoint" — the property that a real
agent binary inside a real container can be reached by the control plane, and
that `ori exec` goes through it. If that property does not hold at the end, this
card is not done, however much code exists.

This is the card that four previous components failed to have. Read
`docs/DIVERGENCES.md` §"The systemic failure: nobody owned the joins" first.

## Why this one matters most

`crates/ori-agent/` is complete — streamed exec, detach, port registration,
secret injection, setup scripts — and **entirely unreachable**, because nothing
on the control plane accepts its WebSocket. Closing this also fixes `exec`:
it currently shells out via `pct exec` per call at 2.7 s, against a 0.90 s
`pct exec` floor, so the overhead is one SSH handshake every time. A persistent
tunnel removes it.

## Build

1. **`GET /api/v1/agent/tunnel`** — WebSocket upgrade. The **sandbox dials the
   control plane**; the plane never dials in. Authenticate the agent (a
   per-sandbox token minted at claim/create time, not the account API key — a
   leaked sandbox token must not be an account credential).
2. **Agent registry** in `AppState`: sandbox id → live tunnel. Handle reconnect
   (replace the old entry), disconnect (mark unreachable), and a sandbox that
   never connects (fall back to the provider's `exec`, and say so).
3. **Route `exec` through the tunnel when connected**, provider `exec` otherwise.
   Same wire response either way — the caller must not be able to tell, except
   by latency.
4. **Stream routing** for the frames C13 adds, so `ssh`/`forward`/`scp` have a
   path once their clients exist. Multiplex by stream id; one wedged stream must
   not stall the tunnel.
5. **Bake the agent into the golden image** and give it its token + plane URL at
   claim time. Coordinate with `scripts/golden-build.sh`, which already
   references an agent artifact.

## Done means — verified, not asserted

- A **real** `ori-agent` musl binary, inside a **real** LXC on the project's
  Proxmox host, connects to a running `ori serve` and appears in the registry.
- `ori exec <id> -- uname -a` returns correct output **through the tunnel**, and
  is measurably faster than the 2.7 s provider path. Record the number.
- Killing the agent falls back to provider exec rather than hanging or erroring.
- Restarting the control plane has agents reconnect without a thundering herd
  (the agent already implements full-jitter backoff — verify it is used).
- Paste the measured latency into `docs/BENCHMARKS.md`.

A passing unit test against a mock tunnel does **not** satisfy this card.
