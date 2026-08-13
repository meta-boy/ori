import { eq, inArray } from "drizzle-orm";
import { ACTIVE, type OriState } from "@ori/contract";
import {
  oriEnv,
  oriEvents,
  oriMetrics,
  oris,
  portRoutes,
  promptRuns,
  snapshotChunks,
  snapshots,
  usageLedger,
} from "../db/schema";
import type { AppDeps } from "../context";
import { purgeOriSnapshots } from "../snapshots/purge";
import { storageConfigFromEnv } from "../snapshots/storageCreds";
import { removeAllPortRoutes } from "../routes/portRoutes";

export type DeleteOutcome =
  | { ok: true; snapshotsDeleted: number; objectsDeleted: number; objectsFailed: number }
  | { ok: false; status: 404 | 409 | 500; code: string; message: string };

/**
 * Delete a ori and everything it owns, including its snapshot data.
 *
 * Nothing else in the system removes snapshot bytes: `stop` archives on purpose, because an
 * archived ori must stay resumable and forkable. That is the right default and the reason a
 * bucket only grows — deleting the ori is the operator's way of saying the data is finished
 * with.
 *
 * Refuses while the ori is active. Deleting a running machine would need a destroy, a final
 * snapshot decision and a billing close in the same breath; `stop` already does all three and
 * is the operation that owns them. Stop first, then delete — one clear error beats a second
 * implementation of stop hidden inside delete.
 *
 * The usage ledger is deliberately NOT deleted. It is billing history: rows are detached from
 * the ori (the column is nullable for exactly this) so what was charged still adds up after
 * the ori it was charged for is gone.
 */
export async function deleteOri(deps: AppDeps, oriId: string): Promise<DeleteOutcome> {
  const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Not found" };

  if ((ACTIVE as readonly string[]).includes(row.state as OriState)) {
    return {
      ok: false,
      status: 409,
      code: "ori_not_deletable",
      message: "Stop the ori before deleting it.",
    };
  }

  // A warm (archived, stopped-but-on-disk) ori holds a container the row is about to forget:
  // reclaim its disk before the row goes, so `ori rm` actually returns the bytes. Best-effort,
  // exactly like the object-store purge below — the row is deleted either way, and a destroy
  // failure surfaces as a leak the operator can clean by hand rather than a refused delete.
  if (row.machineId) {
    await deps.driver.destroy(row.machineId).catch(() => {});
  }

  // Object store first. If it fails we still want the row gone (the operator asked), but the
  // caller is told how many objects survived so a leak is visible rather than silent.
  let objectsDeleted = 0;
  let objectsFailed = 0;
  try {
    const purge = await purgeOriSnapshots(storageConfigFromEnv(), oriId);
    objectsDeleted = purge.deleted;
    objectsFailed = purge.failed.length;
  } catch {
    // Unreachable store, wrong credentials, bucket gone: the row still goes, and
    // objectsFailed = -1 says "we could not even enumerate it".
    objectsFailed = -1;
  }

  const rows = await deps.db.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.oriId, oriId));
  const snapshotIds = rows.map((r) => r.id);

  // The ori is being destroyed for good: take its hosted routes out of the edge first
  // (best-effort; the rows are deleted either way), then FK order — children before parents.
  // snapshot_chunks hangs off snapshots, everything else off oris, and the ledger is
  // detached rather than removed.
  await removeAllPortRoutes(deps, oriId).catch(() => {});
  if (snapshotIds.length > 0) {
    await deps.db.delete(snapshotChunks).where(inArray(snapshotChunks.snapshotId, snapshotIds));
  }
  await deps.db.delete(snapshots).where(eq(snapshots.oriId, oriId));
  await deps.db.delete(oriEnv).where(eq(oriEnv.oriId, oriId));
  await deps.db.delete(oriEvents).where(eq(oriEvents.oriId, oriId));
  await deps.db.delete(promptRuns).where(eq(promptRuns.oriId, oriId));
  await deps.db.delete(portRoutes).where(eq(portRoutes.oriId, oriId));
  await deps.db.delete(oriMetrics).where(eq(oriMetrics.oriId, oriId));
  await deps.db.update(usageLedger).set({ oriId: null }).where(eq(usageLedger.oriId, oriId));
  await deps.db.delete(oris).where(eq(oris.id, oriId));

  return { ok: true, snapshotsDeleted: snapshotIds.length, objectsDeleted, objectsFailed };
}
