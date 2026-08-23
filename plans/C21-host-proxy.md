# C21 — `ori host`: a public URL for a port

**Owns the seam:** a service inside a sandbox, reachable from a browser.

`ori host <id> <port>` returns a stable HTTPS URL routed to a port inside the
sandbox. Private (token-gated) by default; `--public` opts out.

## Build

1. **Reverse proxy in the control plane**, keyed by the sandbox's slug
   subdomain (`<slug>.<domain>`). The sandbox already has a `slug` and a `url`
   field — this makes them mean something.
2. **Route through the agent's `Tcp` stream** to the port on loopback inside the
   sandbox. Same primitive as `ssh` and `desktop`; no new transport.
3. **Token gating by default.** A private URL without a token is a 401, not a
   silent 404 — the difference matters when debugging.
4. WebSockets must pass through. A dev server with hot reload is the common case
   and it breaks first if upgrade headers are dropped.

## The error that matters most

A service bound to `127.0.0.1` inside the sandbox is unreachable; it must bind
`0.0.0.0`. This is the single most common user mistake with this feature.

`crates/ori-agent/src/host.rs` already detects it by reading `/proc/net/tcp[6]`
and reports `listening` and `loopbackOnly`. **Use that.** Returning a URL that
404s when we already know why is the failure mode to avoid — say "nothing is
listening on 3000" or "bound to loopback, rebind to 0.0.0.0" instead.

## Done means

A real HTTP server started inside a real sandbox, reachable through the returned
URL from outside; the private URL rejects a missing token; a WebSocket upgrade
survives the proxy; and a loopback-bound service produces the explanatory error
rather than a dead link.
