# Open decisions

One question the build deliberately did not answer, because it is not a technical
coin-flip — it changes what the product is. (Two others — the snapshot-secret key id and
the cross-ori restore write access — are resolved below, recorded so the reasoning does
not disappear.) Each entry says what it costs to keep deferring.

Nothing here is a bug. The system is green with the open decision deferred.

---

## 1. Snapshot-secret rotation — the derivation has no key id

**State:** ~~`HMAC(ORI_SNAPSHOT_SECRET, "ori-snapshot-repo:" + oriId)`, no version prefix.~~ **RESOLVED.**

**Decided:** the derivation now carries a key id — `HMAC(ORI_SNAPSHOT_SECRET, "ori-snapshot-repo:" +
KEY_ID + ":" + oriId)` — with `KEY_ID` an env var defaulting to `v1`. Repos created before the
change used the un-prefixed derivation and must keep opening, so password resolution probes each
repo (`restic cat config`, read-only, lock-free) and returns whichever derivation opens it
(`snapshotRepoPasswords()` + `resolveRepoPassword()` in `packages/api/src/snapshots/restic.ts`;
wired into `mintGuestStorage` in `packages/api/src/snapshots/take.ts`, the single funnel every
repo read and write goes through).

**What rotation now looks like:** bump `KEY_ID` to `v2` (and change `ORI_SNAPSHOT_SECRET`) for NEW
repos while old repos keep resolving to `v1` — no migration needed for existing repos to stay
readable; re-keying N repos is still the cost of actually exercising rotation, but it is no longer
a prerequisite for keeping them open.

---

## 2. Cross-ori restore hands out write access to the parent's snapshots

**State:** ~~`packages/api/src/snapshots/storageCreds.ts` mints credentials with
`s3:GetObject, s3:PutObject, s3:DeleteObject` scoped to one prefix. A fork restores from
its *parent's* prefix (`repoOriId`), so during that window the fork's credentials can
write to and delete from the parent's snapshot repository.~~ **RESOLVED.**

**Why it is not urgent:** the credentials are short-lived (≤1h), prefix-scoped, and the
cross-ori denial test still holds for every ori that is not the restore source — ori A
cannot touch ori C. The exposure is exactly one ori, for one restore, and only to a ori
that was legitimately forked from it.

**Why it still matters:** it violates the §5 security invariant as written ("no other
ori's data is ever reachable from inside a ori"). A ori has sudo, so a malicious fork
could delete its parent's snapshot chain.

**Decided:** a cross-ori fork-restore now mints **read-only** credentials (`GetObject` +
`ListBucket`) scoped to the parent's prefix (`mintGuestStorage(..., { readOnly: true })`),
so a fork can read its parent's repo but structurally cannot write to or delete from it.
One empirical wrinkle found while verifying: restic takes a lock write even for a read-only
`restore`, which read-only credentials deny — so the restore path passes `--no-lock`
(restic's own documented answer for read-only repositories; the restore genuinely never
writes to the source repo). Verified against real minio with both the host's restic 0.19.x
and the ori image's restic 0.16.4: restore with read-only creds without `--no-lock` fails
with "Access Denied" on the lock write; with `--no-lock` it succeeds.

---

## 3. One namespace everywhere — RESOLVED

**Decided:** a single naming scheme across the wire protocol, not just the branding, and no
aliases carried for older shapes.

Naming is consistent all the way down, which is the property worth having: `/api/ori/v1/*`
paths, `or_xxxxxxxx` sandbox ids, `ori_live_…` API keys, `ori_mt_` / `ori_at_` per-machine
tokens, `ori.created` / `ori.error` envelope types, `openapi/ori-v1.yaml`, and `Ori` / `oriId`
/ the `oris` table in the domain model. Nothing has two names, so there is no aliasing layer
to keep in sync and no ambiguity about which form is current.

**What that costs.** `make e2e-sdk` proves internal consistency rather than compatibility with
any external client: it generates a client from this spec and drives this server. That still
catches a spec which cannot generate a working client, which is the failure worth catching,
but it is a claim about this project only and the README should not imply more.

