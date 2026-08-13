import { and, eq, inArray } from "drizzle-orm";
import { snapshotChunks, snapshots } from "../db/schema";
import type { AppDeps } from "../context";
import { Restic, type ResticForgetOptions } from "./restic";
import { mintGuestStorage } from "./take";

/**
 * Snapshot retention: drop what the policy no longer keeps, in the repo and in our rows.
 *
 * Its own module because it is neither taking a snapshot nor restoring one — it is the third
 * thing that happens to a repo, and putting it in `take.ts` left that file owning three unrelated
 * concerns and the reaper importing retention from a file named "take".
 */

/**
 * The default policy: roughly the last hour at minute granularity, plus a week of dailies.
 *
 * Resume and fork only ever read the newest snapshot, so nothing in the product needs more than
 * one; `keepLast: 50` exists so a person can go back through an afternoon's work, and `keepDaily`
 * so they can go back through a week of it.
 */
export const DEFAULT_RETENTION: ResticForgetOptions = { keepLast: 50, keepDaily: 7 };

/** What one retention pass dropped. */
export interface RetentionResult {
  /** Short restic ids removed from the repo by `forget`. */
  removedFromRepo: string[];
  /** Control-plane snapshot rows deleted as a consequence (chunks first, FK order). */
  rowsDeleted: number;
  /** Whether this pass also ran `prune`, the half that actually frees bytes. */
  pruned: boolean;
}

/**
 * Apply retention to ONE sandbox's repo: `forget` what the policy drops, delete the rows that
 * described those snapshots, and — only when asked — `prune` to reclaim the space.
 *
 * `forget` on its own frees NOTHING. It unlinks snapshots from the repo index while every pack
 * file they referenced stays exactly where it was; only `prune` rewrites the packs and returns
 * bytes to the object store. Keeping them on one flag rather than two calls is what stops the
 * cheap half from being mistaken for the whole job, which is the mistake this code made first.
 *
 * A sandbox that has never been snapshotted is short-circuited before any storage call: there is
 * no repo to forget in (minting credentials would only fail) and no rows to delete.
 */
export async function applyRetention(
  deps: AppDeps,
  oriId: string,
  opts: { policy?: ResticForgetOptions; prune?: boolean } = {},
): Promise<RetentionResult> {
  const policy = opts.policy ?? DEFAULT_RETENTION;
  const any = await deps.db.query.snapshots.findFirst({
    where: eq(snapshots.oriId, oriId),
    columns: { id: true },
  });
  if (!any) return { removedFromRepo: [], rowsDeleted: 0, pruned: false };

  const storage = await mintGuestStorage(oriId);
  const restic = new Restic({
    bin: process.env.RESTIC_BIN ?? "restic",
    repo: storage.repoUrl,
    password: storage.password,
    s3: {
      endpoint: storage.endpoint,
      accessKey: storage.credentials.accessKeyId,
      secretKey: storage.credentials.secretAccessKey,
      sessionToken: storage.credentials.sessionToken,
      region: storage.region,
    },
  });
  try {
    const res = await restic.forget(policy);
    let rowsDeleted = 0;
    if (res.removeFullIds.length > 0) {
      const removed = await deps.db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(and(eq(snapshots.oriId, oriId), inArray(snapshots.resticId, res.removeFullIds)));
      const rowIds = removed.map((r) => r.id);
      if (rowIds.length > 0) {
        // FK order: snapshot_chunks references snapshots.id with no cascade, so the chunks of a
        // forgotten snapshot must be deleted before the row.
        await deps.db.delete(snapshotChunks).where(inArray(snapshotChunks.snapshotId, rowIds));
        await deps.db.delete(snapshots).where(inArray(snapshots.id, rowIds));
      }
      rowsDeleted = rowIds.length;
    }
    if (opts.prune) await restic.prune();
    return { removedFromRepo: res.removeIds, rowsDeleted, pruned: opts.prune === true };
  } finally {
    await restic.close();
  }
}

/** What one fleet-wide pass reclaimed. */
export interface FleetRetentionResult {
  rowsDeleted: number;
  /** Repos whose pass threw — an unreachable object store, or a repo already locked. */
  failed: number;
}

/**
 * Apply retention across every sandbox that has a snapshot.
 *
 * SERIAL, deliberately. Each pass spawns a real `restic` process that pulls the repo index, and
 * this product's default host is 4 cores and 6 GB — fanning out one restic per sandbox is exactly
 * the thrash the per-minute tick is written to avoid. It runs on an hourly clock where wall-time
 * does not matter, so there is nothing to buy by making it concurrent.
 *
 * A repo that cannot be reached must not stop the rest, hence per-ori catch rather than a loop
 * that throws out of the pass. One expected cause of failure is restic's own repo lock: the
 * guest's 60s backup and this `forget` contend for it, and the loser errors out. That is safe to
 * swallow — a snapshot that failed is retried next tick, and a forget that failed is retried next
 * hour. It is the reason this counts failures rather than pretending they cannot happen.
 */
export async function applyRetentionToFleet(
  deps: AppDeps,
  opts: { policy?: ResticForgetOptions; prune?: boolean } = {},
): Promise<FleetRetentionResult> {
  const ids = await deps.db.selectDistinct({ oriId: snapshots.oriId }).from(snapshots);
  const out: FleetRetentionResult = { rowsDeleted: 0, failed: 0 };
  for (const { oriId } of ids) {
    try {
      const res = await applyRetention(deps, oriId, opts);
      out.rowsDeleted += res.rowsDeleted;
    } catch {
      out.failed++;
    }
  }
  return out;
}
