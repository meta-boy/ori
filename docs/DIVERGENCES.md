# Divergences from the ori public API

This project's stated goal is that a client generated against the published OpenAPI v1
works unmodified against our base URL. Anything we return that the spec does not describe
breaks that, so every such thing is listed here with a reason. **An undeclared divergence
is a bug**, and `packages/contract/test/divergences.test.ts` fails the build for any error
code that appears in neither `openapi/ori-v1.yaml` nor this file.

Ori publishes error codes in **two** places and neither is a superset of the other, so a
code justified by either one is not a divergence:

1. `openapi/ori-v1.yaml` names only the codes its own examples happen to use. It carries
   nine the docs table omits: `forbidden`, `gateway_error`, `start_limit_reached`,
   `invalid_env`, `is_symlink`, `base_image_file`, `legacy_snapshot`,
   `snapshot_not_indexed`, `inventory_too_large`.
2. The published status/code table lists six the spec never references:
   `prompt_required`, `machine_not_running`, `billing_required`, `not_found`,
   `ori_restoring`, `daily_limit_reached`.

The first run of the drift test flagged all six from (2) as invented, which is how the
asymmetry surfaced.

## Error codes

| code | status | why it exists | compatibility impact |
|---|---|---|---|
| `subdomain_taken` | 409 | `PATCH /oris/{id}` accepts a `subdomain`, and two oris cannot hold the same one. The spec documents no code for that collision — its 409 codes are `provider_not_configured`, `ori_not_promptable`, `resume_failed`, none of which fit. | A client switching on 409 codes sees an unknown value. It still gets a 409 with a human-readable `message`, so generic error handling is unaffected. |
| `internal_error` | 500 | Last-resort handler for an unexpected throw. The spec's 5xx codes (`invalid_json_response`, `stream_failed`, `gateway_error`) are all specific to a particular failure, and misreporting an arbitrary crash as one of those would be worse than admitting it is unclassified. | Only reachable when we have a bug. |
| `display_disabled` | 409 | `POST /oris/{id}/desktop` on a ori created without `display: true`. The spec has no notion of a ori that may not have a desktop, because upstream every machine can. Here the desktop is opt-in per ori, so a refusal needs a code of its own; the near neighbours (`ori_not_promptable`, `machine_not_running`) both describe a machine that is temporarily unable, not one that was never asked to have a display. | A generated client sees an unknown 409 code with a clear `message`. Only reachable on oris this server created with the flag off, which is the default here. |
| `ori_not_deletable` | 409 | `DELETE /oris/{id}` while the ori is still active. Delete refuses rather than quietly stopping first — stop owns the final snapshot and the billing close. | Reachable only via the delete endpoint, which is itself a divergence. |

## Endpoints

| endpoint | why | compatibility impact |
|---|---|---|
| `GET /internal/edge/ask` | Caddy's on-demand TLS gate. Asks whether a hostname is a live route before issuing a certificate. Not in the spec because ori's edge is internal to their deployment. | None — internal, bound to localhost, never routed publicly. Answers existence only. |
| `GET /internal/edge/validate` | `forward_auth` target for the `_token` query gate on hosted ori ports. | None — internal, as above. |
| `POST /internal/oris/{id}/events`, `/snapshots`, `/routes`, `/heartbeat`, `GET /storage-creds` | The ori→control-plane channel, authenticated by a per-ori machine token. The spec does not publish a shape for this channel. | None — internal. |
| `POST /api-keys` | The spec only has `GET /api-keys`; keys are minted through the dashboard, which is out of scope here. We provide `scripts/create-key.ts` server-side rather than a public endpoint, so this is a **non**-divergence, recorded to explain the asymmetry. | None. |
| `DELETE /oris/{oriId}` | The spec has **no** delete at all: a machine is stopped and its snapshots live on, and the storage bill is theirs to absorb. Self-hosting inverts that — the bucket is the operator's disk, and without a delete it only ever grows. This is the only operation in the system that destroys snapshot data, which is why it refuses unless the ori is already stopped and why both clients ask for confirmation. | A generated client never calls it. The documented paths and their behaviour are unchanged. |
| `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/session` | Dashboard sign-in. The spec has no auth endpoints at all because its dashboard authenticates with a GitHub OAuth session that never appears in the public API. A self-hosted dashboard needs *some* way to sign in, and the alternative — keeping a long-lived API key in `localStorage` — puts a credential somewhere any XSS can read it. Mounted outside `/api/ori/v1` so the documented surface is untouched. | None for generated clients: the documented paths and their auth are unchanged, and a bearer key still works everywhere it did before. |

### Session cookies as an alternative to bearer keys

`authMiddleware` accepts a `ori_session` cookie **only when no `Authorization` header is
present**. Bearer keys remain the documented path, so a client generated from the spec behaves
exactly as before, and a request that presents a key is judged on that key alone rather than
silently falling back to a cookie the browser happened to attach. The cookie is `HttpOnly` and
`SameSite=Strict`; the latter is the CSRF defence, since the cookie is simply never attached to a
request originating from another site. `/internal/*` never accepts cookies.

Sign-up is **invite-only**, and that is a security decision rather than a product one: this
control plane is designed to be reachable through a tunnel, and every account that exists can
spawn containers on the host. Open registration would turn a shared URL into a container farm.
Mint an invite with `scripts/create-invite.ts`; it is single-use and stored only as a hash.

## Deliberate behavioural differences

| area | ori | here | why |
|---|---|---|---|
| Desktop streaming | Moonlight/WebRTC H.264 60fps by default, VNC over HTTPS as fallback | VNC only | VNC is ~10% of the work and is ori's own documented fallback. Sunshine/WebRTC is backlog, not pretended. |
| Snapshot restore | lazy hydration, "usable in a few seconds whatever the ori holds", with prefetch learned from access patterns | eager `restic restore` before the ori reports `ready` | Correct first, fast later. The ceiling is stated rather than hidden. |
| Regions | Germany, Finland, France | wherever you run it | Self-hosted. |
| Machine sizes | `small` 2 vCPU/4GB, `default` 4/8, `large` 8/16 | `nano` 1 vCPU/0.5GB, `small` 1/1, `default` 2/2, `large` 4/4 | The workload here is an agent running shell commands, not a developer's desktop, and the host is usually one spare machine. Every rung has to fit beside the control plane, postgres and minio on ~16GB. A client that assumed `large` meant 16GB gets 4GB. `nano` is additionally a type name the spec does not have. |
| Desktop | every machine can open one | opt-in per ori (`display: true` at create; `POST /desktop` returns `display_disabled` otherwise) | The units were always lazy — they start on demand and cost nothing until then — so this is not a memory saving. It stops an automated caller from starting Xvfb, budgie and VNC on a 512MB box by accident. |
| `POST /oris/{id}/sshkey` response | `machineIp` + `sshUser`; a machine has a routable IPv4 and sshd is on 22 | adds `sshHost`, `sshPort`, `machineId` | The docker driver gives a ori no routable address — sshd is published on the control-plane host's loopback, which `machineIp` cannot express. `machineId` says which machine the ori currently runs on, so a client can pin host keys per machine: a resume or fork builds a new machine with new host keys, and pinning by ori id instead makes every resume look like an impersonation attempt. Additive fields; a generated client ignores them. |
| Billing | Stripe plans, credit packs, per-second metering | a `usage_ledger` table and `/limits` computed from it; no payment | v1 is the sandbox platform, not the business around it. |

## Snapshot chunks, generations and sizes (restic)

The spec's model (`SnapshotDownloadResponse`) is that a download returns
"every chunk across the chain, ordered by `(generation, chunkIndex)`", and the
`SnapshotChunk{r2Key, sizeBytes, sha256, signedUrl}` shape implies those chunks, in
that order, reassemble the filesystem. Our storage is **restic**, whose pack objects
are content-addressed and deduplicated across the whole repository — one pack can hold
blobs from several generations, so per-generation pack attribution is not available.
We map `chunk` → a restic data pack object (stored at `data/<id>` under the ori's repo
prefix), with `sha256` being the pack's content hash (restic names packs by it) and
`sizeBytes` its object size. A snapshot's registration lists the packs its backup added
to the repo, so across the chain each pack appears once, under the generation that
first stored it.

Stated plainly: **a client that fetches every chunk we list, in the order we list them,
cannot reconstruct the filesystem.** A restic pack is a container of compressed,
content-addressed blobs; the mapping from blobs to files lives in restic's index and
tree/snapshot objects, which are in the repository but are not part of the chunk list.
The `reconstruct` note in a `snapshot.download` response (T-P5-11) will therefore point
at restic itself and `inventory` will carry the repo metadata a restic client needs —
we will not ship a chunk list that looks reconstructable but is not.

Two smaller semantic differences in `SnapshotSummary`:

| field | ori describes it as | here |
|---|---|---|
| `generation` | "position in the incremental chain (0 = base)" | our first snapshot is generation **1** (kind `base`), the next 2 (`incremental`), and so on — matching the guest's restic-chain count. A client that treats `generation === 0` as "this is the base" must check `kind === "base"` instead. |
| `sizeBytes` / `fileCount` | "bytes this snapshot added (its delta)" / "inventory entries alive in the chain" | restic's processed totals for the whole backup — logical bytes/files **including** the sysdiff — while `contentSizeBytes` / `contentFileCount` hold the ori's own work-dir data (sysdiff excluded). The two pairs are always kept distinct; both are monotonic-ish restic counts, not chain deltas. |

| `pageInfo.followCursor` | GET `/oris/{id}/events` | The spec's `PageInfo` only has `nextCursor`, which is null on the last page (`null` exactly when `hasMore` is false, API-wide). A client long-polling the event stream needs a cursor positioned after the newest event it has seen, so the events response adds `followCursor`. Additive: a client that ignores it paginates exactly as before. |

| `limit_reached` | 429 | `POST /oris/{id}/routes` when the ori already hosts its 50-port cap. The docs table lists `limit_reached` ("Concurrent box limit reached") but the spec's own examples never use it. | A client switching on 429 codes sees an unknown value; it still gets a 429 with a human-readable `message`. |

## Not yet reconciled

`invalid_subdomain` (400) is currently returned for a malformed `subdomain` in
`PATCH /oris/{id}`. The spec documents `invalid_name` for name validation, which most
likely covers subdomains too. Decide: either map it to `invalid_name` and delete the code,
or keep it and move it into the table above with a reason. Until then the drift test will
fail on it, which is the intended pressure.
