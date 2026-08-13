import { eq } from "drizzle-orm";
import { applyAction, type OriState } from "@ori/contract";
import { oris } from "../db/schema";
import type { AppDeps } from "../context";
import { takeSnapshot } from "../snapshots/take";
import { closeUsageLedger } from "./ledger";
import { emitOriEvent } from "./events";
import { teardownEdgeRoutes } from "../routes/portRoutes";
import type { SuspendableDriver } from "../drivers/types";

export type StopOutcome =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 500; code: string; message: string };

/**
 * Request the guest's final snapshot and register it. Goes through takeSnapshot so the
 * scoped credentials and derived repo password the guest requires are minted and passed —
 * calling the guest with only { mode } was rejected, which made every final snapshot fail
 * and (since a failed final snapshot refuses the stop) would have left every ori running
 * and unbilled forever.
 */
async function finalSnapshot(deps: AppDeps, oriId: string): Promise<{ ok: boolean; reason?: string }> {
  const outcome = await takeSnapshot(deps, oriId, "final");
  // A skip is a safe stop, and it is worth saying why rather than letting it ride on truthiness:
  // the guest skips only when nothing has changed since the last SUCCESSFUL snapshot, so that
  // snapshot already describes the disk about to be destroyed. Nothing is lost by not taking
  // another. Only an outright failure may refuse the stop.
  switch (outcome.status) {
    case "created":
    case "skipped":
      return { ok: true };
    case "failed":
      return { ok: false, reason: outcome.reason };
  }
}

/**
 * Archive a ori: archiving → final snapshot → warm stop → archived. The final
 * snapshot must succeed before the machine is halted, or the stop is refused (the
 * ori stays running, unbilled) unless `force` is set.
 *
 * WARM TIER: when the driver can suspend, the machine is STOPPED and kept on host
 * disk rather than destroyed, so a near-term resume starts it in place instead of
 * restoring from restic. The snapshot is already registered, so restic stays the
 * truth — the warm container is a cache, and the row keeps its machineId so the
 * reaper can evict the cache later. A driver without suspend (or an old driver)
 * destroys as before, and the ori is cold on stop.
 */
export async function stopOri(deps: AppDeps, oriId: string, force: boolean): Promise<StopOutcome> {
  const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Not found" };
  const transition = applyAction("stop", row.state as OriState);
  if (!transition.ok) {
    return { ok: false, status: 400, code: transition.code, message: "The ori is not running." };
  }
  const prevState = row.state;
  const now = new Date();

  await deps.db.update(oris).set({ state: "archiving", updatedAt: now }).where(eq(oris.id, oriId));
  await emitOriEvent(deps.db, oriId, "ori.archiving");

  if (!force) {
    const saved = await finalSnapshot(deps, oriId);
    if (!saved.ok) {
      // The save is failing: refuse the stop, keep the ori running and unbilled.
      await deps.db
        .update(oris)
        .set({ state: prevState, lastSnapshotStatus: "failed", lastSnapshotAttemptAt: now, updatedAt: now })
        .where(eq(oris.id, oriId));
      // Carry the real reason. "Final snapshot failed" with the cause swallowed is
      // unfixable in production: the ori stays up unbilled and nobody can tell why.
      const reason = saved.reason ?? "unknown";
      await emitOriEvent(deps.db, oriId, "ori.stop_failed", { data: { reason } });
      return {
        ok: false,
        status: 500,
        code: "internal_error",
        message: `Final snapshot failed; stop refused: ${reason}`,
      };
    }
    // registerSnapshot (inside takeSnapshot) already set snapshot_available,
    // snapshot_completed_at, last_snapshot_attempt_at and last_snapshot_status. One writer
    // of those columns, not two.
  }

  if (row.machineId) {
    const suspend = deps.driver as unknown as SuspendableDriver;
    if (typeof suspend.stop === "function") {
      // Warm: halt the container in place. The final snapshot is already registered, so the
      // disk this container holds is duplicated in restic — halting it loses nothing.
      await suspend.stop(row.machineId);
    } else {
      await deps.driver.destroy(row.machineId);
    }
  }

  // The machine is not serving (stopped warm, or gone cold), so hosted ports are unreachable:
  // pull their edge routes down. The portRoutes rows stay (Box parity: hosting the same port
  // after a resume returns the same URL and token, so links handed out keep working — resume
  // re-registers the edge).
  await teardownEdgeRoutes(deps, oriId).catch(() => {});

  await closeUsageLedger(deps.db, { id: row.id, userId: row.userId, type: row.type, createdAt: row.createdAt }, now);

  // machineId is KEPT for a warm stop: the reaper's eviction needs to find the container, and
  // warm resume needs to start it. ip is cleared — the container is not serving and start()
  // re-reads the address on resume. archived + machineId != null IS the warm state; archived +
  // machineId == null is cold (destroyed or evicted).
  await deps.db
    .update(oris)
    .set({
      state: "archived",
      machineId: row.machineId,
      ip: null,
      desktopAvailable: false,
      desktopToken: null,
      desktopExpiresAt: null,
      updatedAt: now,
    })
    .where(eq(oris.id, oriId));

  await emitOriEvent(deps.db, oriId, "ori.archived");

  return { ok: true };
}
