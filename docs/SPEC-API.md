# ori control-plane API

Base: `{ORI_API_URL}/api/v1`. JSON. Bearer token in `Authorization`.
Client honours `--api-url` and the `ORI_API_URL` environment variable.

## Endpoints

| Method + path | Purpose |
|---|---|
| `GET  /me` | account identity, login state |
| `GET  /sandboxes` | list; `pageInfo{hasMore,limit,nextCursor}` |
| `POST /sandboxes` | create — **streams NDJSON** |
| `GET  /sandboxes/{id}` | detail — `{"sandbox": {...}}` |
| `POST /sandboxes/{id}/stop` | snapshot then power off |
| `POST /sandboxes/{id}/resume` | streams NDJSON |
| `POST /sandboxes/{id}/fork` | streams NDJSON, 202 |
| `POST /sandboxes/{id}/extend` | change the auto-stop deadline |
| `DELETE /sandboxes/{id}` | returns `{"operation": {...}}` |
| `POST /sandboxes/{id}/exec` | run a command without SSH |
| `POST /sandboxes/{id}/ports` | expose a port on a stable HTTPS URL |
| `GET  /operations/{id}` | async operation status |
| `GET/POST /environments[/{name}]` | named environments and versions |
| `GET/POST /snapshots[/{id}]` | filesystem snapshots |
| `GET/POST /named-snapshots[/{name}]` | named snapshots |
| `GET/POST /api-keys[/{id}]` | API keys |
| `GET/POST /webhooks[/{id}]` | lifecycle webhooks |
| `GET  /teams` | billing scopes |
| `POST /cli/login/start`, `GET /cli/login/poll/{id}` | device-code login |
| `GET  /cli/version` | self-update channel check |
| `GET/POST /account/data-retention` | delete-on-stop toggle |

## NDJSON streaming — create, resume, fork

Long operations stream one JSON object per line, **flushed per line**. A
buffered response that arrives all at once is a bug even though the bytes are
identical: the CLI renders progress from this stream and would sit silent for
the whole operation.

```
{"event":"created","id":"ori_a1b2c3d4","ttlSeconds":900,"team":null}
{"event":"state","id":"ori_a1b2c3d4","state":"cloning"}
{"event":"state","id":"ori_a1b2c3d4","state":"ready"}
{"event":"ready","id":"ori_a1b2c3d4","state":"ready","ip":"10.0.0.12",
 "url":"https://<slug>.<domain>","desktopUrl":"...","stopAfter":"<rfc3339>",
 "commands":{"ssh":"ori ssh ori_a1b2c3d4","forward":"ori forward ori_a1b2c3d4 --remote 3000"}}
```

`resume` emits `{"event":"accepted","id":...,"status":"resuming"}` first.
Errors are a **terminal event on the stream**, not a mid-stream status change —
by the time an error is known the HTTP status is long since sent.

`fork` never snapshots a running source: it clones from the newest snapshot
that was taken while the source was **stopped** (a running-taken snapshot is
permanently ~20x slower to clone from — see `docs/BENCHMARKS.md` §Root cause).
Reusing that older snapshot means writes made since the last stop are **not**
in the fork; that is stated on the stream so it is never a silent omission.

```
{"event":"error","id":"ori_a1b2c3d4","code":"provider_unavailable","message":"..."}
{"event":"notice","id":"ori_<child>","message":"forked from the snapshot taken when ori_<src> was last stopped; writes made since that stop are not in this fork"}
```

A running source with **no** stopped snapshot is the common path (`new`, work,
`fork`). Fork then stops the source, snapshots it **while stopped** (the fast
kind), restarts it, and clones — roughly 10 s total with a few seconds of
source downtime. The downtime is **announced on the stream before the stop**
(`notice`), and the source is restarted before cloning, so a failed fork never
leaves it powered off:

```
{"event":"notice","id":"ori_<child>","message":"ori_<src> has never been stopped, so it has no fast snapshot; stopping it for a moment to take one for this fork, then restarting it"}
```

`noStop: true` (`ori fork --no-stop`) opts out of the downtime: the source is
refused instead (terminal `error`, code `invalid_request`), keeping the old
behaviour for anyone who cannot take it.

## Sandbox object

```
id                    "ori_" + 8 [a-z0-9]
name                  human label, defaults to a timestamped name
state                 see state machine
type                  "small" | "default" | "large"
vcpu                  2 | 4 | 8
memoryGB              4 | 8 | 16
billingMultiplier     0.5 | 1 | 2
slug                  three-word slug, unique per account
url                   "https://<slug>.<domain>"   (null when stopped)
ip                    string | null                (null when stopped)
sshEndpoint           string | null
desktopAvailable      bool
desktopUrl            string | null
environment           name, default "base"
environmentVersion    int
createdAt/updatedAt   rfc3339
stopAfter             rfc3339 | null   (auto-stop deadline; null = no auto-stop)
snapshotAvailable     bool
lastSnapshotAttemptAt rfc3339 | null
lastSnapshotStatus    "completed" | "failed" | null
snapshotCompletedAt   rfc3339 | null
setupStatus           "pending"|"running"|"done"|"failed"|null
setupError            string | null
provider              provider name, e.g. "proxmox"
team                  string | null
```

Note `ip` and `url` are null while stopped and **may change across a
stop/resume** — a resumed sandbox can land on different capacity. Nothing may
cache either value across a stop.

## State machine

| Group letter | Meaning | States |
|---|---|---|
| `r` | running | `cloning`, `ready`, `running`, `idle` |
| `s` | stopped | `stopped` |
| `p` | pending | `init`, `provisioning` |
| `t` | stopping | `stopping` |
| `e` | error | `error` |

Default list filter is `r`; `--all` is `rspte`.

```
new      init → provisioning → cloning → ready
stop     ready → stopping → [snapshot] → stopped
resume   stopped → provisioning → ready
fork     source stopped only if it must be snapshot (announced, then restarted); child init → cloning → ready
delete   any → (operation oriop_<hex32>) → gone
expiry   stopAfter reached → stopping → stopped
```

Rejected transitions are a 409 with the attempted edge named, never a silent
no-op — a `resume` on a running sandbox must not start a second provisioning run.

## Identifiers

- sandbox: `ori_` + 8 `[a-z0-9]`
- async operation: `oriop_` + 32 hex
- operation statuses: `pending`, `processing`, `blocked`, `completed`
- `blocked` is real: a snapshot with dependent incrementals cannot be deleted
  (409), and the operation records why.

## Machine types

| type | vCPU | RAM | multiplier |
|---|---|---|---|
| `small` | 2 | 4 GB | 0.5 |
| `default` | 4 | 8 GB | 1 |
| `large` | 8 | 16 GB | 2 |

One source of truth (`ori-proto`); no other crate restates these numbers.

## Auth

- **API key** — `Authorization: Bearer <key>`, hashed at rest (argon2/scrypt;
  never plaintext, never a bare SHA). Secret shown once at creation; afterwards
  only prefix + last four.
- **Device-code login** — `POST /cli/login/start` returns a code and URL, the
  client polls `/cli/login/poll/{id}` until a token is issued. Token cached in
  the client config file at mode 0600.

`POST /sandboxes` **refuses** (`409 capacity_exceeded`) when the host cannot
take another sandbox for the requested machine type — thin-pool headroom after
the warm-pool footprint (the `scripts/preflight.sh` §6 arithmetic) or free
memory is short, and the message names which resource.

`GET /me` backs `ori status`:

```json
{"account":{"identifier":"...","loginState":"active","status":"active"},
 "api":{"healthy":true,"status":"healthy","url":"...","error":null},
 "config":{"apiUrl":"...","channel":"stable","path":"..."}}
```
