# Edge routes — the Caddy admin-API contract

This is the exact contract the control-plane Caddy client (P6) codes against to
add and remove one public ori route. The control plane owns the proxy config: oris never hold routing credentials, they only call
`POST /internal/oris/:id/routes`, and the control plane reconciles the Caddy
config through the admin API on `localhost:2019`.

The edge's static scaffolding (`infra/Caddyfile`) is loaded at boot. Everything
below is injected **on top of** that active config at runtime. Do not use
`POST /load` for this — it replaces the whole config (including the Caddyfile,
the admin/binding/on-demand settings) and fights the Caddyfile. Use the
fine-grained `/config/...` endpoints.

## Server name

Routes live in the HTTP server array `apps.http.servers.<name>.routes`. The
Caddyfile auto-names its single HTTPS server `srv0`. The client should still
resolve the name once so the contract does not depend on the adapter's naming order:

```bash
curl -s localhost:2019/config/apps/http/servers \
  | jq -r 'to_entries[] | select(any(.value.listen[]; . == ":443")) | .key'
# srv0
```

Replace `<srv>` with the result in the paths below.

## Addressing and concurrency

- `POST   /config/<path>` — **appends** to an array, creates/replaces an object.
- `PUT    /config/<path>` — **inserts** at an array index (shifts existing).
- `PATCH  /config/<path>` — **replaces** an existing value / array element.
- `DELETE /config/<path>` — deletes the value.
- `@id` gives each route a stable handle under `/id/...`, so add/remove never
  depends on positional index. Every route carries `@id = <hostname>`.
- ALL mutations against the read-modify-write-free endpoints are safe to issue
  concurrently with the **conflict** mechanism: `GET` a scope, keep its `Etag`,
  set `If-Match` on the mutating call, and retry on HTTP 412.

## The route object for one ori:port

Hostname pattern: `<subdomain>-<port>.on.<EDGE_DOMAIN>` (a single DNS label
`<subdomain>-<port>` under `on.<EDGE_DOMAIN>`). Example in this doc:
`myapp-8080.on.ori.local` -> ori IP `10.10.0.5`, ori port `8080`, control plane
at `127.0.0.1:8080`.

### Gated (private) route — carries the `_token` forward_auth gate

`forward_auth` is not a standalone JSON module; it is a `reverse_proxy` handler
configured to GET the control plane, then continue on a 2xx (source of truth:
`modules/caddyhttp/reverseproxy/forwardauth/caddyfile.go`, the "expanded form"
in the Caddy docs). The control plane reads `_token` from the `X-Forwarded-Uri`
request header this gate sets; on non-2xx the validate response is returned to
the client verbatim and the ori is never touched.

The gate deliberately uses **no `copy_headers`**: the ori's hosted app is
arbitrary user code and must not receive authenticated identity headers
(also avoids the `copy_headers` header-injection advisory GHSA-7r4p-vjf4-gxv4
in Caddy <= 2.11.1).

```bash
curl -X PUT localhost:2019/config/apps/http/servers/<srv>/routes/0 \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "@id": "myapp-8080.on.ori.local",
  "match": [
    { "host": ["myapp-8080.on.ori.local"] }
  ],
  "terminal": true,
  "handle": [
    {
      "handler": "reverse_proxy",
      "upstreams": [ { "dial": "127.0.0.1:8080" } ],
      "rewrite": { "method": "GET", "uri": "/internal/edge/validate" },
      "headers_up": {
        "request": {
          "set": {
            "X-Forwarded-Method": [ "{http.request.method}" ],
            "X-Forwarded-Uri": [ "{http.request.uri}" ]
          }
        }
      },
      "handle_response": [
        {
          "match": { "status_code": [ 2 ] },
          "routes": [
            { "handle": [ { "handler": "vars" } ] }
          ]
        }
      ]
    },
    {
      "handler": "reverse_proxy",
      "upstreams": [ { "dial": "10.10.0.5:8080" } ]
    }
  ]
}
JSON
```

`PUT .../routes/0` **inserts at index 0**, so the new route runs before the
Caddyfile's catch-all (`respond 404`). `"terminal": true` stops routing once a
hostname matches its route.

### Public route — gate omitted

For a route registered with `public: true`, the control plane omits the gate
handler entirely; `handle` is just the ori proxy. Same object as above but with:

```json
  "handle": [
    {
      "handler": "reverse_proxy",
      "upstreams": [ { "dial": "10.10.0.5:8080" } ]
    }
  ]
```

## Remove one route

```bash
curl -X DELETE localhost:2019/id/myapp-8080.on.ori.local
```

`DELETE` on the `@id` handle removes the route object from the array. The
positional equivalent is `DELETE /config/apps/http/servers/<srv>/routes/<index>`.

## What the client must do after add/remove

Confirm with `curl -s localhost:2019/config/apps/http/servers/<srv>/routes | jq` —
the hostname should appear/be absent. Watch for `HTTP 4xx`; a 400 means the JSON
did not validate (bad module name / field shape), a 412 means an Etag conflict
(stale read; retry with a fresh `GET`).

## The two control-plane endpoints this contract depends on

The edge requires two control-plane endpoints that **section 5 of the plan does
not name**. Both are referenced from this edge; they are the only gaps vs. the
plan doc. Proposals (exact shapes to confirm when implementing the control
plane):

| Purpose | Method/Path | Reads | Returns |
|---|---|---|---|
| On-demand TLS `ask` | `GET {CONTROL_PLANE_BASE}/internal/edge/ask?domain=<hostname>` | hostname in `port_routes` | 200 iff registered, else non-2xx |
| `_token` gate | `GET {CONTROL_PLANE_BASE}/internal/edge/validate` | `_token` from `X-Forwarded-Uri`, host from `X-Forwarded-Host` | 2xx iff token valid for that host, else non-2xx passed to the client |

Everything else in this contract (route registration/teardown) is driven by the
documented `POST /internal/oris/:id/routes` write-path plus the Caddy admin
API; no other control-plane endpoint is invented.