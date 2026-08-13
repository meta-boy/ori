# ori-infra — edge and host configuration

The infrastructure halves of the platform:

- **Caddy edge** (`Caddyfile`) — terminates TLS for every public ori hostname and
  proxies to the ori. Static scaffolding here; the per-ori routes are injected
  at runtime by the control plane through the admin API.
- **Host bootstrap** (`bootstrap.sh`) — turns a fresh Ubuntu 24.04 bare-metal
  host into a ori host: Incus + ZFS, a routed network giving each ori its own
  IPv4, Caddy, and the load-bearing firewall.
- **systemd units** (`systemd/`) — the control plane service (on the host) and
  the in-ori guest agent.
- **`edge-routes.md`** — the exact admin-API contract the control-plane Caddy
  client codes against (add/remove one route).

## Layout

| Path | Purpose |
|---|---|
| `Caddyfile` | Edge scaffold: admin on localhost:2019, on-demand TLS `ask`, JSON logging, timeouts, the `*.on.EDGE_DOMAIN` wildcard site. |
| `edge-routes.md` | The JSON route object + `PUT/DELETE` admin-API calls for one ori:port route (add and remove). |
| `systemd/ori-api.service` | Runs the control plane on the host (`:8080`, both `/api/ori/v1` and `/internal/*`). |
| `systemd/ori-guest-agent.service` | Runs inside each ori (`:7777`); token from an env file, never the CLI. |
| `systemd/caddy.service.d/edge.conf` | Injects `EDGE_DOMAIN` / `CONTROL_PLANE_BASE` into the packaged Caddy service. |
| `env/*.example` | Document the env-file shape; `bootstrap.sh` writes the real files. |
| `bootstrap.sh` | One-shot idempotent host provisisoning. |

## The request flow for one public ori URL

`https://myapp-8080.on.ori.local` (assuming `EDGE_DOMAIN=ori.local`, ori IP
`10.10.0.5`, app on ori port `8080`):

1. **DNS** – `myapp-8080.on.ori.local` must resolve to the host's public IP
   (a wildcard `*.on.EDGE_DOMAIN` record). Before that, a `host <port>` call has
   already made the ori hit `POST /internal/oris/:id/routes`, and the control
   plane has inserted one JSON route into Caddy (`edge-routes.md`).
2. **TLS** – A client connects with SNI `myapp-8080.on.ori.local`. Caddy's
   on-demand TLS asks the control plane
   (`GET {CONTROL_PLANE_BASE}/internal/edge/ask?domain=myapp-8080.on.ori.local`).
   The control plane answers `2xx` iff the hostname is in `port_routes`; Caddy
   then obtains/uses a certificate. Otherwise the handshake is refused. This is
   what stops certificate issuance for arbitrary hostnames.
3. **Token gate** – The route's first handler is a `forward_auth` pre-check: a
   GET to `{CONTROL_PLANE_BASE}/internal/edge/validate` carrying the original
   request (and `_token`) in `X-Forwarded-Uri`. It returns 2xx iff `_token` is
   valid for that hostname; on any non-2xx the validate response is returned to
   the client and the ori is never contacted. Routes created with `--public`
   omit this handler entirely, so they are reachable without a token.
4. **Proxy** – On success, the second `reverse_proxy` handler dials
   `10.10.0.5:8080`, streaming the ori app's response back over the TLS
   connection the edge terminated.

The 4-step answer to "how does a public URL work": **DNS → SNI/on-demand-cert →
`_token` gate → ori:port**, with the control plane holding both the certificate
gate and the token gate, never the ori.

## Adding / removing one route (the contract)

See `edge-routes.md`. In short:

```bash
# server name (the Caddyfile site is auto-named srv0)
SRV=$(curl -s localhost:2019/config/apps/http/servers \
        | jq -r 'to_entries[] | select(any(.value.listen[]; . == ":443")) | .key')

# add (insert at index 0, before the 404 catch-all); body = the JSON in edge-routes.md
curl -X PUT localhost:2019/config/apps/http/servers/$SRV/routes/0 \
  -H 'Content-Type: application/json' --data-binary @route.json

# remove
curl -X DELETE localhost:2019/id/myapp-8080.on.ori.local
```

## Operator run order (fresh host)

1. `sudo apt-get update && sudo apt-get install -y git` (you are on `ori-infra`)
2. `./infra/bootstrap.sh` — installs Incus+ZFS+Caddy, creates the routed
   network + firewall + service user + units, writes `/etc/caddy/edge.env` and
   `/etc/ori/ori-api.env`, enables `caddy` and (idempotently) `ori-api`.
3. Deploy the dynamically-built artifacts from the repo (`packages/api`):
   place the control-plane binary at `/usr/local/bin/ori-api`.
4. Set the real `DATABASE_URL` in `/etc/ori/ori-api.env` (the Docker Compose
   `postgres` is for dev; a production host runs its own Postgres).
5. `systemctl enable --now ori-api`.
6. Set a real `EDGE_DOMAIN` in `/etc/caddy/edge.env` and `systemctl restart
   caddy` — needed for public certificates (see TLS below).
7. Add a `*.on.<EDGE_DOMAIN>` DNS record pointing `*.on.<EDGE_DOMAIN>` at the
   host.

## TLS and the dev default (`ori.local`)

`Caddyfile` binds `EDGE_DOMAIN` from the environment with `ori.local` as the
dev default (written by `bootstrap.sh` into `/etc/caddy/edge.env`). `ori.local`
is not a resolvable public name, so the default ACME issuers cannot sign
certificates for `*.on.ori.local`. This is a deliberate ceiling, not a bug:

- **Production** – set `EDGE_DOMAIN` to your real domain (step 6). On-demand
  TLS then works against Let's Encrypt / ZeroSSL as-is.
- **Offline dev** – to test the full edge locally, either use Caddy's built-in
  ACME server and point the global `acme_ca` at it, or add `local_certs` to the
  global options and trust Caddy's internal root. Change exactly one line.

## Firewall (load-bearing)

Port **7777** on every ori is reachable only from the control plane. The rule
lives on the host because all ori traffic must traverse it (routed NICs):

```
-A FORWARD -s <GATEWAY> -d <ORI_SUBNET> -p tcp --dport 7777 -j ACCEPT  # control plane
-A FORWARD -d <ORI_SUBNET> -p tcp --dport 7777 -j DROP                 # everyone else
```

Also on the host: `22` (admin SSH) and `80/443` (edge) are open; the control
plane's `:8080` is open to the ori subnet and loopback only; everything else to
the host or to oris is dropped. Rules are applied atomically via
`iptables-restore` and persisted with `netfilter-persistent`.

## Known gaps vs the plan

Two control-plane endpoints the edge needs are **not defined in section 5** of
the plan; the plan told us not to invent them, so they are flagged, not hidden:

- `GET /internal/edge/ask?domain=<hostname>` — the on-demand TLS gate (must be
  a fast, indexed `port_routes` lookup; any 2xx = issue).
- `GET /internal/edge/validate` — the `_token` forward-auth gate.

`edge-routes.md` and the `Caddyfile` reference both. Whoever implements the
control-plane routes should treat these two as required additions to section 5.
No other section-5 contract shape is changed.

Other scoped deferrals are each commented with a `ponytail` note in the file
that introduced them (ZFS on a loop file, `.1`-gateway assumption for
non-/24 subnets, NAT for private ranges, dev TLS).