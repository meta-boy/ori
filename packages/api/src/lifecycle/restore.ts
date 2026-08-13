import { eq } from "drizzle-orm";
import { oris } from "../db/schema";
import type { AppDeps } from "../context";
import { provisionToReady, waitForGuestHealth } from "./provision";
import { restoreSnapshot } from "../snapshots/take";
import { emitOriEvent } from "./events";
import { reregisterAllPortRoutes } from "../routes/portRoutes";

/**
 * Restore a snapshot onto a freshly created machine, then provision it — the shared tail of both
 * resume and fork.
 *
 * It lives here because resume and fork had a copy each, and the copies had already drifted: one
 * destroyed the machine when the restore failed and the other left it running. Two implementations
 * of "what happens when a restore fails" is one more than the number of correct answers.
 */
export interface RestoreThenProvisionInput {
  /** The ori being restored INTO — the one whose machine runs the restore. */
  oriId: string;
  /** Its machine, so a failed restore can tear down what it was going to run on. */
  machineId: string;
  snapshotRef: string;
  scrubEnv: boolean;
  /** The ori whose REPOSITORY holds the snapshot. A fork must pass its source; a resume its own. */
  repoOriId?: string;
  /** Which states `provisionToReady` may flip to ready from — `cloning` for a fork. */
  fromStates?: readonly string[];
  /**
   * What a failed restore leaves behind. A resume goes back to `archived`, because its snapshot
   * is still there and `resume` is legal from `archived` — so a transient failure is retryable
   * instead of terminal. A fork has no snapshot of its own to come back from, so it stays
   * `error` and its source is left untouched.
   */
  onFailure?: "archived" | "error";
}

/**
 * How long to wait for a brand-new machine's guest agent before calling the restore failed.
 * A knob because it tracks host speed, not logic: create->ready measured 6.6s (default) to
 * 12.7s (small) on one Proxmox LXC host, and a busier or slower host will want more.
 */
const guestWaitMs = (): number => Number(process.env.ORI_RESTORE_GUEST_WAIT_MS ?? 30_000);

/**
 * Restore then provision in ONE background task — the two must not race.
 *
 * The guest agent answers /health as soon as the container boots, which is DURING the restore, so a
 * `provisionToReady` started concurrently would flip the ori to `ready` while the snapshot is still
 * being copied onto the disk. Chaining provision here, only after a successful restore, preserves
 * the strict restore → provision order that the old synchronous code got by awaiting the restore
 * before firing provision.
 *
 * The caller has already returned 202 by the time this runs, which is a real change in contract and
 * worth naming: a failure is no longer a 500 the caller sees, it is a state the caller must poll
 * for. That is why the failure path writes both an `ori.restore_failed` event AND `state = error` —
 * the event for anyone reading history, the state for the dashboard and CLI, which poll.
 */
export async function restoreThenProvision(deps: AppDeps, input: RestoreThenProvisionInput): Promise<void> {
  const { oriId, machineId, snapshotRef, scrubEnv, repoOriId, fromStates, onFailure = "error" } = input;
  try {
    // The machine is seconds old. Wait for its guest agent to listen before handing it a
    // restore: without this, the very first dial lands in the window before
    // ori-agent.service is up and every fork and cold resume dies on
    // `guest POST /restore: unreachable`.
    const waitMs = guestWaitMs();
    if (!(await waitForGuestHealth(deps, oriId, { deadlineMs: waitMs }))) {
      await failRestore(deps, oriId, machineId, `guest agent not healthy within ${waitMs}ms`, onFailure);
      return;
    }
    const restored = await restoreSnapshot(deps, oriId, snapshotRef, scrubEnv, repoOriId);
    if (!restored.ok) {
      await failRestore(deps, oriId, machineId, restored.reason ?? "restore failed", onFailure);
      return;
    }
    await provisionToReady(deps, oriId, fromStates ? { fromStates } : {});
    // The machine is fresh: re-add the edge routes for any ports the ori hosted before
    // (the rows survived stop), so URLs and tokens handed out earlier keep working.
    await reregisterAllPortRoutes(deps, oriId).catch(() => {});
  } catch (e) {
    // Even a thrown restore (a DB hiccup, a guest that vanished mid-call) must land the ori in
    // error, and the trailing .catch means a DB outage while writing THAT error still resolves the
    // task rather than leaking an unhandled rejection out of a background job.
    await failRestore(deps, oriId, machineId, (e as Error).message, onFailure).catch(() => {});
  }
}

/**
 * Record a failed restore and tear down the machine it would have run on.
 *
 * The teardown is the part that used to differ between resume and fork. Destroying is right for
 * both: the machine is freshly created and empty — the snapshot never landed on it — so it holds
 * memory and CPU while being useless, and nothing else would ever reap it. The ori keeps its
 * snapshot, so a resume or fork can simply be retried.
 */
async function failRestore(
  deps: AppDeps,
  oriId: string,
  machineId: string,
  reason: string,
  outcome: "archived" | "error" = "error",
): Promise<void> {
  await emitOriEvent(deps.db, oriId, "ori.restore_failed", { data: { reason, outcome } });
  await deps.driver.destroy(machineId).catch(() => {});
  await deps.db
    .update(oris)
    .set({ state: outcome, error: `restore failed: ${reason}`, machineId: null, ip: null, updatedAt: new Date() })
    .where(eq(oris.id, oriId));
}
