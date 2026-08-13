import { and, eq, inArray, sql } from "drizzle-orm";
import { oris, snapshotChunks, snapshots } from "../db/schema";
import type { AppDeps } from "../context";
import { GuestClient } from "../guest/client";
import { mintOriStorageCredentials, storageConfigFromEnv } from "./storageCreds";
import { oriRepoUrl, resolveRepoPassword } from "./restic";
import { registerSnapshot, type RegisterOutcome } from "./register";

/**
 * Take one snapshot of a ori: mint scoped credentials, ask the guest to back up, register
 * the result. This is the ONLY path that should call the guest's /snapshot, so the
 * credential minting and the registration cannot drift apart from each other.
 *
 * The control plane mints and passes the credentials rather than the ori fetching them
 * itself (§5 amendment): a ori has sudo, so it should hold nothing durable. What it gets
 * here expires within the hour and is powerless outside its own object prefix.
 */

/** The server secret that derives every repo password. Never defaulted — see docs/OPERATIONS.md. */
export function snapshotSecret(): string {
  const secret = process.env.ORI_SNAPSHOT_SECRET;
  if (!secret) {
    // Deliberately fatal. A fallback would silently share one password across every
    // deployment that forgot to set it, and snapshots would keep working — readable by
    // anyone who knows the default.
    throw new Error("ORI_SNAPSHOT_SECRET is not set; refusing to derive a repo password");
  }
  return secret;
}

/**
 * Per-ori STS credential cache.
 *
 * Without this, every auto-snapshot attempt minted a fresh AssumeRole session — one signed
 * round-trip to the object store per sandbox per minute, most of which the guest then threw
 * away by answering "skipped". Credentials already expire within the hour, so caching one
 * per ori and refreshing it before expiry cuts the mint rate from ~60/hour/sandbox to
 * ~1/hour/sandbox. The cache holds only SUCCESSFUL mints; a failure falls through to the
 * caller exactly as before and caches nothing.
 *
 * Keyed by the ori whose object PREFIX the session is scoped to, plus the mode (rw/ro) —
 * a fork mints for the source's prefix, read-only (see restoreSnapshot); the mode is part
 * of the key so a read-write session is never served to a read-only caller of the same
 * prefix or vice versa. Values are never mutated by callers, so sharing one object across
 * attempts is safe. Entries are dropped once past their expiry; an unbounded map of
 * one-hour sessions would otherwise grow with every sandbox that ever ran.
 */
const storageCredCache = new Map<
  string,
  { storage: ReturnType<typeof buildGuestStorage>; expiresAtMs: number }
>();

/**
 * Refresh a cached session this long before it actually expires. The margin is what keeps a
 * backup that starts at TTL-14min from failing mid-run with revoked credentials; the guest's
 * own restic timeout is 60s, and the margin is far larger than that.
 */
const CRED_REFRESH_MARGIN_MS = 15 * 60_000;

/** Assemble the storage object handed to the guest. */
function buildGuestStorage(creds: Awaited<ReturnType<typeof mintOriStorageCredentials>>, oriId: string, password: string) {
  return {
    repoUrl: creds.repoUrl,
    endpoint: creds.endpoint,
    bucket: creds.bucket,
    prefix: creds.prefix,
    region: creds.region,
    password,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  };
}

/**
 * Mint the storage a guest call needs: scoped, short-TTL S3 credentials plus the derived
 * repo password. Shared by snapshot and restore so the two cannot drift — sending a guest
 * call without this is what broke /snapshot (and would have broken every resume and fork).
 *
 * `readOnly:true` requests a session narrowed to GetObject + ListBucket (OPEN-DECISIONS
 * #2): a FORK restores from its parent's prefix, and the restore never writes there, so the
 * fork must not be handed write credentials to the parent's repo. The cache key carries the
 * mode, so a read-write session minted for a prefix is never reused for a read-only caller
 * of the same prefix or vice versa.
 */
export async function mintGuestStorage(oriId: string, opts: { readOnly?: boolean } = {}) {
  const key = `${opts.readOnly ? "ro:" : "rw:"}${oriId}`;
  const cached = storageCredCache.get(key);
  if (cached && cached.expiresAtMs - Date.now() > CRED_REFRESH_MARGIN_MS) {
    return cached.storage;
  }
  const config = storageConfigFromEnv();
  const creds = await mintOriStorageCredentials(config, oriId, { readOnly: opts.readOnly });
  // The repo password is DERIVED with a key-id prefix (OPEN-DECISIONS #1), and repos
  // created before that change used the un-prefixed derivation — a probe picks whichever
  // actually opens this repo. The probe runs from the CONTROL PLANE, so it uses the
  // control-plane endpoint and the just-minted session creds, not the ori-facing ones
  // (creds.repoUrl points at the address a CONTAINER reaches, unusable from here).
  const password = await resolveRepoPassword({
    oriId,
    serverSecret: snapshotSecret(),
    repo: oriRepoUrl(config.endpoint, config.bucket, oriId),
    s3: {
      endpoint: config.endpoint,
      accessKey: creds.accessKeyId,
      secretKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
      region: config.region ?? "us-east-1",
    },
  });
  const storage = buildGuestStorage(creds, oriId, password);
  storageCredCache.set(key, { storage, expiresAtMs: creds.expiresAt.getTime() });
  // Sweep expired entries on the way in, so the map stays bounded by live sessions.
  for (const [k, entry] of storageCredCache) {
    if (entry.expiresAtMs <= Date.now()) storageCredCache.delete(k);
  }
  return storage;
}

/**
 * Three outcomes, and the third one matters: a skipped snapshot is neither a success to be
 * counted as new data nor a failure to be retried or zero-rated — the guest decided nothing had
 * changed and correctly did nothing.
 *
 * Discriminated on `status` rather than an `ok` field holding a string. An `ok` that can be
 * `"skipped"` is truthy, so every `if (outcome.ok)` silently treats a skip as a success and the
 * type needs a usage rule to be safe. Naming the states makes the compiler ask each caller which
 * one it means. This mirrors the guest's own result type, which already discriminates on a tag.
 */
export type TakeOutcome =
  | { status: "created"; snapshotId: string; register: RegisterOutcome }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export async function takeSnapshot(
  deps: AppDeps,
  oriId: string,
  mode: "auto" | "final",
  /**
   * The caller's clock. The reaper passes its tick time so an attempt is recorded at the
   * moment the tick considered it, not at wall-clock now — otherwise two ticks minutes
   * apart in logical time stamp the same instant and the cadence can never advance.
   */
  now?: Date,
): Promise<TakeOutcome> {
  const at = now ?? deps.now?.() ?? new Date();
  const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  if (!row) return { status: "failed", reason: "ori not found" };
  const tokens = deps.tokens.get(oriId);
  if (!row.ip || !tokens) return { status: "failed", reason: "ori has no reachable agent" };

  let storage;
  try {
    storage = await mintGuestStorage(oriId);
  } catch (e) {
    // Minting failed (object store down, secret unset). Record the attempt so the reaper's
    // zero-rating window sees it: a ori we cannot back up must not be billed.
    const failed = await registerSnapshot({ ...deps, now: () => at }, oriId, {
      ok: false,
      type: "snapshot.failed",
      mode,
      error: `storage credentials unavailable: ${(e as Error).message}`,
    });
    return { status: "failed", reason: `storage credentials unavailable (${failed.ok ? "" : "recorded"})` };
  }

  try {
    const result = await GuestClient.forIp(row.ip, tokens.agentToken).snapshot(mode, storage);
    // The guest skips when its change-detection probe finds nothing moved since the last
    // successful snapshot. That is the detector succeeding, not a snapshot failing: nothing is
    // registered (no row, no event) and, because `lastSnapshotStatus` is left alone, nothing is
    // zero-rated either — an idle sandbox is still a running sandbox.
    //
    // The skip DOES advance the cadence clock and the skip-streak — that is what lets the
    // reaper back an idle sandbox's cadence off instead of probing it every minute forever
    // (each probe costs a full-tree lstat walk and an STS mint). A skip is the ONLY thing
    // that advances the streak; registerSnapshot resets it on every other outcome.
    //
    // The ONE exception is a sandbox whose last snapshot FAILED: there the clock stays
    // anchored to the failure ('s zero-rating window keys on lastSnapshotAttemptAt,
    // and a skip must not extend it indefinitely) and the streak stays 0, so a broken backup
    // is retried at the base 60s cadence rather than compounding with the backoff. Nothing to
    // write in that case at all — not even updatedAt, which would burn a write per probe and
    // stop meaning "something about this ori changed".
    if (result.type === "snapshot.skipped") {
      if (row.lastSnapshotStatus !== "failed") {
        await deps.db
          .update(oris)
          .set({ lastSnapshotAttemptAt: at, snapshotSkipStreak: sql`${oris.snapshotSkipStreak} + 1`, updatedAt: at })
          .where(eq(oris.id, oriId));
      }
      return { status: "skipped", reason: result.reason ?? "no changes since the last successful snapshot" };
    }
    const register = await registerSnapshot({ ...deps, now: () => at }, oriId, {
      ok: true,
      type: "snapshot.created",
      mode,
      snapshotId: result.snapshotId,
      sizeBytes: result.sizeBytes,
      fileCount: result.fileCount,
      // The guest reports one total, sysdiff included; it does not yet separate the work
      // dir from the system delta. Carrying the same number in both rather than inventing
      // a split keeps the field honest until the guest reports them apart.
      contentSizeBytes: result.sizeBytes,
      contentFileCount: result.fileCount,
      // Chunk rows are the repo's data packs. Listing them needs an S3 list against the
      // ori prefix, which only the download endpoint (T-P5-11) consumes, so it is built
      // there rather than on every 60s snapshot.
      chunks: [],
      createdAt: result.createdAt,
    });
    return { status: "created", snapshotId: result.snapshotId, register };
  } catch (e) {
    await registerSnapshot({ ...deps, now: () => at }, oriId, {
      ok: false,
      type: "snapshot.failed",
      mode,
      error: (e as Error).message,
    });
    return { status: "failed", reason: (e as Error).message };
  }
}

/**
 * Restore a ori's disk from a snapshot. Mints the same storage a snapshot needs — the guest's
 * /restore requires it, and GuestClient.restore used to send only { snapshotRef, scrubEnv },
 * which would have failed every resume and every fork.
 *
 * `scrubEnv` carries --no-env through: the guest removes the owner's credentials from the
 * restored disk BEFORE the ori is reachable, so a no-env fork handed to someone else cannot
 * act as the parent's owner.
 *
 * CROSS-ORI FORK-RESTORE (OPEN-DECISIONS #2, now resolved): when `repoOriId` is set and
 * differs from the ori being restored into, the storage minted for that repo is READ-ONLY
 * (GetObject + ListBucket). A fork restores from its parent's prefix, and the restore never
 * writes there — so the fork's short-lived credential must not be able to write to or delete
 * from the parent's snapshot repository either. Read access is inherent to forking; write
 * access is not.
 */
export async function restoreSnapshot(
  deps: AppDeps,
  /** The ori being restored INTO — whose agent runs the restore. */
  oriId: string,
  snapshotRef: string,
  scrubEnv: boolean,
  /**
   * The ori whose REPOSITORY holds the snapshot. Defaults to oriId (a resume reads its own
   * repo). A FORK must pass the source's id: the snapshot lives under oris/<source>/, and
   * minting for the fork's own empty prefix makes restic report "unable to open config
   * file / is there a repository at this location" — which is what it did.
   */
  repoOriId?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  if (!row) return { ok: false, reason: "ori not found" };
  const tokens = deps.tokens.get(oriId);
  if (!row.ip || !tokens) return { ok: false, reason: "ori has no reachable agent" };

  try {
    // The snapshot lives in repoOriId's repo (default: this ori's own). When that repo is a
    // DIFFERENT ori's prefix (a fork restoring from its parent), mint read-only credentials:
    // the restore path never writes to the source repo, so write access would only widen the
    // exposure the storage-creds invariant is drawn against.
    const crossOri = repoOriId !== undefined && repoOriId !== oriId;
    const storage = await mintGuestStorage(repoOriId ?? oriId, { readOnly: crossOri });
    await GuestClient.forIp(row.ip, tokens.agentToken).restore(snapshotRef, scrubEnv, storage);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
