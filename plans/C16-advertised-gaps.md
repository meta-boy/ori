# C16 — close the advertised-but-missing commands

**Owns the seam:** every value the API hands a user must be usable by that user.

These are not absent features. They are holes in behaviour the product already
advertises, which makes them worse than the stubs: the API returns a thing and
then gives you no way to act on it.

## 1. `ori extend` — currently a stub

Every sandbox carries a `stopAfter` deadline and is reaped when it passes.
`extend` is the only way to move that deadline, and it is unimplemented, so a
sandbox dies on its TTL with no recourse. Wire `POST /sandboxes/{id}/extend`
(the route exists) to `--hours`, `--ttl` and `--no-auto-stop`.

Bound it: refuse a deadline in the past, and say what the new deadline *is* in
the response rather than just succeeding.

## 2. `ori operation` — currently a stub

`delete` returns `{"operation": {"id": "oriop_…", "status": "pending"}}`. The
user cannot query that id. Wire `GET /operations/{id}` to the CLI and render
`pending | processing | blocked | completed`.

`blocked` is the case that matters and the one most likely to be dropped: a
snapshot with dependent incrementals cannot be deleted, and the operation must
report *why* rather than sitting in `pending` forever.

## 3. `ori limits` — **remove it**, and replace it with something real

Decision: drop the command and the plan/quota concept entirely. Billing-style
per-account quotas are meaningless for a self-hosted tool, and `GET /limits`
currently reports numbers that may not be enforced at all — a quota nobody
enforces reads as a guarantee, which is worse than having none.

Delete the `limits` command, the endpoint, and the plan fields it reports.

**Replace it with a host capacity guard**, which is the need underneath it. This
is not hypothetical: during this project a leaked-container bug put 13 sandboxes
on the host and filled it. Refuse `new` when the host cannot take another
sandbox — thin-pool headroom and free memory, checked against the configured
machine type — and say which resource is short. Grounding: the preflight script
already computes pool footprint and headroom (`scripts/preflight.sh` emits
`ORI_POOL_HEADROOM_GB`); reuse that arithmetic rather than inventing a second
notion of "full".

## 4. `ori api-key` — list / rotate / revoke

The bootstrap mints the first key and there is no lifecycle after that: no
listing, no rotation, no revocation. A key that cannot be revoked is a security
problem, not a missing feature.

Show prefix + last four only. The secret is shown once at creation and never
again — that is already how create behaves; do not weaken it.

## Done means

Each of these driven through the real CLI against a running `ori serve`, with
the stub rows replaced in `docs/STATUS.md`. For `extend`, prove the reaper
actually honours the new deadline rather than the old one — a test that only
checks the API response would pass while the sandbox still dies on schedule.
