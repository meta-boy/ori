# STATE
phase: P5
next: T-P6-00

| id | subject | deps | status | note |
|----|---------|------|--------|------|
| T-P0-01 | bun workspace + tsconfig + .gitignore + git init | - | DONE | workspace/Makefile pre-existing; git init completed P0 bootstrap |
| T-P0-02 | plans (LOOP/STATE/CARD-TEMPLATE) | T-P0-01 | DONE | plan §8 cards reference the phase files |
| T-P0-03 | docker-compose (postgres17+minio+bucket) + .env.example | - | DONE | postgres healthy on 5432; ori-snapshots bucket created |
| T-P0-04 | Makefile with all five targets | T-P0-01 | DONE | pre-existing; verify currently 142 pass |
| T-P0-05 | drizzle-kit + §6 schema + first migration + db:reset | T-P0-03 | DONE | 13 tables; migration 0000_fearless_havok.sql; db:reset+db:check green |
| T-P0-06 | scripts/ci.sh = make verify | T-P0-04 | DONE | bash scripts/ci.sh green |
| T-P1-01 | transcribe OpenAPI | - | DONE | 25 paths / 30 ops (plan gossip said 31; 25 is correct) |
| T-P1-02 | contract ids/states/machines/errors | - | DONE | |
| T-P1-03 | zod schemas + generated types | - | DONE | types checked into schemas.ts |
| T-P1-04 | envelope helpers | - | DONE | |
| T-P1-05 | test/contract harness | - | DONE | |
| T-P2-01 | Hono app + request-id + error handlers | - | DONE | app.ts+middleware; verify 148 pass |
| T-P2-02 | auth middleware (sha256, timing-safe) | - | DONE | Bearer ori_live_ → sha256 lookup → user; 401; last_used_at. verify 156 pass |
| T-P2-03 | GET /me | T-P2-02 | DONE | GET /me returns user.info; validated via harness.MeResponseSchema |
| T-P2-04 | GET /api-keys + create-key script | T-P2-02 | DONE | metadata only; scripts/create-key.ts mints ori_live_; verify 161 pass |
| T-P2-05 | GET /limits | T-P2-02 | DONE | every LimitsFields key; canStart/activeOris from ledger+oris; verify 164 pass |
| T-P2-06 | creation rate limiter | T-P2-02 | DONE | 600/h+1500/day ceilings + per-account minute/day; verify 173 pass |
| T-P2-07 | GET/POST /secrets + validation | T-P2-02 | DONE | name regex, ≤100 vars, 64KB, abs/.. path rejection; verify 185 pass |
| T-P2-08 | GET/POST /repos stub | T-P2-02 | DONE | v1 stub: empty installations, echo selection; verify 193 pass |
| T-P3-01 | driver types + fake driver + fake guest | T-P2-01 | DONE | 4-method MachineDriver; fake guest over loopback HTTP; timingSafeEqualHex now used; verify 217 pass |
| T-P3-02 | POST /oris create | T-P3-01 | DONE | validate+limits+rate limit, mint tokens, provisioning->ready on guest health; verify 233 pass |
| T-P3-03 | GET list/get + PATCH /oris | T-P3-02 | DONE | newest-first cursor pagination, subdomain uniqueness 409; verify 247 pass |
| T-P3-04 | stop | T-P3-03 | DONE | archiving->final snapshot->destroy->archived; force skips snapshot; ledger closed; desktop token invalidated; verify 255 pass |
| T-P3-05 | resume | T-P3-04 | DONE | archived->provisioning->restore->ready; type_too_small resize rejection; scrub stub; start+TTL reset; verify 264 pass |
| T-P3-06 | fork | T-P3-05 | DONE | cloning->restore latest snapshot->ready; env inherit/noEnv; type_too_small shrink; start recorded; verify 276 pass |
| T-P3-07 | events + GET events | T-P3-04 | DONE | writer wired into create/ready/archiving/archived/stop_failed/resuming/restoring/cloning/error; GET /events seq cursor pagination + type filter; verify 287 pass |
| T-P3-08 | reaper | T-P3-07 | DONE | one tick() in reaper.ts; auto-stop via stopOri, per-tick accrual, finding-11 zero-rating window, driver-dead -> error; own throwaway DB in its test; 10 pass |
| T-P3-09 | state-machine property test | T-P3-08 | DONE | 8 actions × 10 states = 83 tests; exposed + fixed stop (narrow STOPPABLE) and fork (silent init / wrong error) vs §4 table; verify 387 pass |
| T-P4-01 | guest-agent package (:7777, /health, auth, systemd) | T-P3-09 | DONE | Hono+0.0.0.0:7777, bearer agentToken (timing-safe), /health shape per §5, JSON request logging, ori-agent.service at /opt/ori/guest-agent/ori-agent; crypto helpers moved to @ori/contract; 9 tests |
| T-P4-02 | guest /exec | T-P4-01 | DONE | bash -lc, cwd resolved+realpath-checked (ORI_WORK_DIR default /home/user), group-kill timeout, 1MB caps that drain, CommandResponse fields; 17 tests |
| T-P4-03 | guest /file GET+PUT | T-P4-01 | DONE | resolved-path escapes incl symlink write, secret-path validator, 10MB cap, base64 round-trip, 0600, dir 400 / missing 404; 18 tests |
| T-P4-04 | guest /env | T-P4-01 | DONE | ORI_ENV_FILE atomic 0644 write, bash-safe quoting round-trips, finding-33 validators, secret files 0600 with symlink-escape rejection; 14 tests |
| T-P4-05 | API POST /oris/{id}/commands | T-P4-01 | DONE | GuestClient.exec + GuestError translation (400 invalid_json / 502 gateway_error / 500), applyAction gate, 404 uniform; fake guest rejects bad cwd/timeout; Connection:close; 9 tests |
| T-P4-06 | API GET/PUT /oris/{id}/files + /artifacts | T-P4-01 | DONE | GuestClient readFile/writeFile/artifact (no inline HTTP), shared translateGuestError lifted from commands route; files route rewrites only path wording (refused not skipped) and carries guest cap message; /artifacts streams via dedicated guest /artifact endpoint (not /exec — /exec returns capped JSON, cannot stream); body limit raised 1MB->16MB so guest (not middleware) rejects over-cap; fake guest stores raw bytes (utf8 detour corrupts >0x7f); 11 tests, verify 468 pass |
| T-P4-07 | drivers/docker.ts | T-P4-06 | DONE | real DockerMachineDriver: ori-base container, systemd PID1 with the 5 verified flags, agent cross-compiled with bun build --compile and mounted at /opt/ori/guest-agent/ori-agent, set-environment + enable --now ori-agent, ip=127.0.0.1:<ephemeral host port>, create() waits for /health; oriIp() now nulls host:port in the public Ori.ip; 5 tests incl real container lifecycle; verify 473 pass |
| T-P4-08 | image/ base image build | - | DONE | merged from wt/image; per-ori SSH host keys; field notes in plan §8 |
| T-P4-09 | test/e2e/local.ts + make e2e-local | T-P4-08 | DONE | 12 steps against real containers: ready, uname Linux, toolchain, files+cat-on-disk, binary byte-exact, artifacts file+tar, stop, container gone |

| T-P5-01 | snapshots/restic.ts wrapper | T-P4-07 | DONE | thin Restic wrapper (init/backup+tags/snapshots/ls/dump/restore/forget), explicit bin+repo+password+S3 inputs, ResticError carries stderr, no password/secret on argv; repo=oriRepoUrl() s3:.../oris/<oriId>, password=snapshotRepoPassword() HMAC(server secret, oriId) — DERIVED not stored; 10 tests vs real minio, unique repo prefix/run, graceful skip if restic or minio missing; verify 483 pass |
| T-P5-02 | GET /internal/oris/:id/storage-creds, prefix-scoped | T-P5-01 | DONE | minio STS AssumeRole with an inline session policy; Get/Put/Delete on oris/<id>/* and ListBucket conditioned on s3:prefix; 1h TTL; machine-token only. Denial test issues REAL signed S3 calls: A gets 403 on B read/write/delete/list and on whole-bucket list, 200 on its own. Fixed MACHINE_TOKEN_REGEX drift that 401d every real token |
| T-P5-03 | guest /snapshot: restic backup + sysdiff | T-P5-02 | DONE | POST /snapshot {mode, storage:{repoUrl,endpoint,bucket,prefix,region,password,credentials}} — creds passed BY the control plane (scope decision), result RETURNED not posted; restic backup of workdir + volumes (skip missing) + one sysdiff.tar (dpkg, enabled units, /etc-vs-baseline, crontabs); machine identity excluded; final failure honest (500, never a false success); creds/password redacted; wrapper gained sessionToken->AWS_SESSION_TOKEN; image writes /opt/ori/ori-image/etc-manifest.json baseline; verify 522 pass |
| T-P5-04 | snapshot registration + chunk rows | T-P5-03 | DONE | registerSnapshot(deps,oriId,result): snapshots+snapshot_chunks rows, generation/chainId/kind per ori, ori.snapshot_* fields, idempotent on restic id, failed->last_snapshot_status only; chunk=restic pack divergence declared in DIVERGENCES.md; 11 tests, verify 533 pass |
| T-P5-05 | auto-snapshot cadence + blocking final snapshot | T-P5-04 | DONE | cadence off the reaper tick (one clock), takeSnapshot mints creds+password and registers; fixed GuestClient.snapshot sending no storage, which would have failed every final snapshot and left every ori running unbilled; zero-rating asserted on the usage ledger, not the flag |
| T-P5-06 | guest /restore + sysdiff re-apply | T-P5-04 | DONE | restic restore via staging dir, then re-applies the sysdiff: /etc diff, systemctl enable --now per previously-enabled unit, crontab sections. Machine identity NEVER restored (a fork would inherit its parent's ssh host keys). Package reconciliation opt-in and never fatal |
| T-P5-07 | --no-env scrub on restore | T-P5-06 | DONE | scrub runs the moment the disk lands, before any unit is enabled or the ori can be marked ready; removes .ssh (incl authorized_keys), gh/ori/claude/codex/aws/netrc/git-credentials/npmrc/pypirc and /etc/ori.env; a credential it cannot delete THROWS rather than continuing. Also fixed GuestClient.restore sending no storage, which would have failed every resume and fork |
| T-P5-08 | GET /snapshots, /oris/{id}/snapshots, /latest | T-P5-04 | DONE | list/latest: /snapshots across the caller's oris, per-ori list, latest-or-null; ownership by join, lossless cursor paging |
| T-P5-09 | GET /snapshots/{id}/tree | T-P5-08 | DONE | tree via restic ls, mapped to {path,kind,size} |
| T-P5-10 | GET /snapshots/{id}/files (file or folder-as-tar) | T-P5-08 | DONE | files via restic dump, STREAMED not buffered (a folder can be gigabytes) |
| T-P5-11 | GET /snapshots/{id}/download (chunks + signed urls) | T-P5-08 | DONE | download tells the truth: reconstruct points at restic, inventory carries repo metadata, credentials deliberately excluded |
| T-P5-12 | e2e: data/package/unit survive stop-resume, fork independent | T-P5-06 | DONE | 12/12 against real containers + restic + minio: file and enabled unit survive a destroy/rebuild, hand-run process does not come back, fork inherits and is independent. Found 5 bugs incl. /etc delta silently capturing nothing |

| T-P6-00 | expand P6 into cards from the plan outline | - | TODO | strong model: read the P6 outline in the plan, write full cards |
| T-P6-01 | per-ori routed IPv4 + firewall (7777 only from control plane) | T-P6-00 | TODO | needs a real host; the docker driver has no routable IP by design |
| T-P6-02 | POST /internal/oris/:id/routes from the in-ori `host` CLI | T-P6-00 | TODO | machine token must be injected for this — see the §5 amendment |
| T-P6-03 | Caddy admin API client: add/remove a route per hostname | T-P6-00 | TODO | infra/edge-routes.md is the contract |
| T-P6-04 | on-demand TLS ask endpoint /internal/edge/ask | T-P6-03 | TODO | unauthenticated, rate-limit it, answers existence only |
| T-P6-05 | _token forward_auth gate /internal/edge/validate | T-P6-03 | TODO | constant-time compare; --public disables |
| T-P6-06 | 50-route cap, teardown on stop, re-register on resume, subdomain rename | T-P6-03 | TODO | |
| T-P6-07 | e2e: serve a port from a ori and fetch it through the edge | T-P6-06 | TODO | BLOCKED without a real domain + routed IPv4 |

| T-P7-01 | guest POST /sshkey + API POST /oris/{id}/sshkey | - | DONE | key validated (single line, known type, private-key paste refused), appended idempotently, 0700/.ssh + 0600 authorized_keys, CHOWNED to the home owner — root-owned keys are what sshd silently refuses. Driver publishes 22 and reports sshHost/sshPort (declared divergence: the spec's machineIp cannot express loopback+port) |
| T-P7-02 | e2e-ssh: real login, unauthorised key refused, password auth off | T-P7-01 | DONE | 7/7 |
| T-P7-03 | CLI ori ssh / scp / forward wrapping the system ssh | T-P7-01 | TODO | belongs with P10 |

| T-P10-01 | CLI: login/status/new/list/info/exec/ssh/stop/resume/fork/snapshots, --json | T-P7-01 | DONE | one file, thin over HTTP + system ssh; verified live end to end against a real container: login, new, list, exec, ssh login, stop, snapshots |
| T-P10-02 | server picks a REAL driver by default (ORI_DRIVER) and runs the reaper | - | DONE | the entry used FakeMachineDriver, so a real server created oris that did not exist while looking healthy; fake is now opt-in and warns |
| T-P10-03 | bun build --compile per platform | T-P10-01 | DONE | `make cli` builds this machine's, --all does darwin/linux x arm64/x64; 58M self-contained, verified driving a real ori under `env -i`. Install script + self-update + the /api/ori/cli/download channel endpoint still TODO |
| T-P10-04 | shell integration exporting ORI_CURRENT_ID via ORI_CURRENT_ID_FILE | T-P10-01 | DONE | the SHELL owns 'current', not the CLI, so terminals do not fight over it; new/fork/resume report the id, every id-taking command falls back to it, and exec/ssh disambiguate by the ori-id shape. Verified live |

| T-P8-01 | desktop token + POST /oris/{id}/desktop + authenticating proxy | T-P7-01 | DONE | HMAC token bound to ONE ori, hour TTL, expiry inside the signature; proxy gates BOTH the html and the websocket; revocation is real because the row's token is checked, not just the signature. Live: with token 200 noVNC, without 401, wrong ori 401, after stop 401 |
| T-P8-02 | guest lazy desktop start/stop; driver publishes 6080 on loopback | T-P8-01 | DONE | starting novnc pulls xvfb+openori+x11vnc; polls until noVNC actually answers rather than trusting "active" |
| T-P8-03 | CLI ori desktop | T-P8-01 | DONE | prints the URL and opens a browser; warns when still provisioning |
| T-P8-04 | Sunshine/WebRTC 60fps desktop | T-P8-01 | TODO | backlog per §2; VNC is ori's own documented fallback |

| T-P11-01 | generated TS SDK from the spec + make sdk | - | DONE | openapi-typescript -> schema.d.ts, ~20-line openapi-fetch binding; generated, never hand-written, so spec gaps cannot hide |
| T-P11-02 | e2e-sdk: a generated client drives a real ori | T-P11-01 | DONE | 9/9 — me, create, poll ready, commands, files round-trip, list, events, stop, and a 404 arriving in the documented envelope |
| T-P11-03 | Python SDK (openapi-generator, snake_case Configuration) | T-P11-01 | TODO |
| T-P12-01 | apply account secrets + per-box env to machines (create/resume/fork) | - | DONE | parity gap #2: secrets stored but never delivered; applies via guest /env before ready |
| T-P12-02 | push secrets to running oris on POST /secrets | T-P12-01 | DONE | parity gap #2: pushed.updated reflects live pushes |
| T-P12-03 | CLI new --env/--no-env | T-P12-01 | DONE | parity gap #5 |
| T-P12-04 | guest /prompt + /prompt/:id/status + /interrupt (tmux harness) | - | DONE | parity gap #1: runs codex/claude-code CLI in-box, provider_not_configured when missing; detached group kill; 5 guest tests |
| T-P12-05 | API POST /oris/:id/prompt + prompt-status + interrupt + event poller | T-P12-04 | DONE | parity gap #1: routes exist in spec, were never registered; poller streams response events; 5 API tests |
| T-P12-06 | CLI prompt/events/interrupt | T-P12-05 | DONE | parity gap #5; 7 CLI tests |
| T-P12-07 | port routes: public + internal endpoints, subdomain auto-assign, 50-cap | - | DONE | parity gap #3: public + machine-token route endpoints, subdomain auto-assign, sticky token, 50-cap, edge ask/validate; 8 API tests |
| T-P12-08 | Caddy admin client + /internal/edge/ask + /internal/edge/validate | T-P12-07 | DONE | parity gap #3: Caddy admin client (Etag retry, @id, forward_auth gate) + NoopRegistrar; ORI_CADDY_ADMIN_URL-gated |
| T-P12-09 | guest /host CLI + driver port publish | T-P12-07 | DONE | parity gap #3: guest /host (host/list/url/hide) via machine token; driver passes ORI_MACHINE_TOKEN+ORI_CONTROL_PLANE; hostAddress driver capability; 4 guest tests |
| T-P12-10 | CLI extend/limits/config/dashboard/completions/api-key/logout | - | DONE | parity gap #5 |
| T-P12-11 | CLI scp/forward | - | DONE | parity gap #5; forward tunnels via existing ssh ProxyCommand |
| T-P12-12 | CLI snapshot latest/tree/pull | - | DONE | parity gap #5 + snapshots fix; pull streams workdir+volumes via files endpoint |
| T-P12-13 | TS SDK waiters/helpers | - | DONE | parity gap #5: waitUntilReady, waitForPrompt, readText, execCommand, ... |
| T-P12-14 | route teardown on stop/delete + re-register on resume | T-P12-07 | DONE | parity gap #3: teardown on stop (rows kept), delete (rows+edge gone), re-register on resume; same URL/token |
 a Python SDK is still wanted; needs java or docker for the generator |

Status ∈ TODO · DOING · DONE · BLOCKED · NEEDS-SPEC.