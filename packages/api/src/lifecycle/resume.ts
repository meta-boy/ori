import { desc, eq } from "drizzle-orm";
import { fitsType, type RequestableMachineType } from "@ori/contract";
import { oris, snapshots } from "../db/schema";
import type { AppDeps } from "../context";
import { BASE_IMAGE } from "../constants";
import { agentToken, machineToken } from "../tokens";
import { sha256Hex } from "../middleware/auth";
import { recordStart } from "../rateLimit";
import { provisionToReady } from "./provision";
import { restoreThenProvision } from "./restore";
import { restoreSnapshot } from "../snapshots/take";
import { emitOriEvent } from "./events";
import { reregisterAllPortRoutes } from "../routes/portRoutes";
import type { SuspendableDriver } from "../drivers/types";

export type ResumeOutcome =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409 | 500; code: string; message: string };

/** Latest registered snapshot for a ori, newest generation first. */
export async function latestSnapshot(deps: AppDeps, oriId: string) {
  return deps.db.query.snapshots.findFirst({
    where: eq(snapshots.oriId, oriId),
    orderBy: desc(snapshots.generation),
  });
}

/**
 * Bring an archived ori back up: archived → provisioning → ready.
 *
 * WARM TIER: when the stop left the machine on host disk (a warm stop), resume starts it in
 * place and provisions — no create, no restic restore, sub-second. The row's machineId is
 * kept by stop, so "still exists?" is the whole test; start() re-reads the address because
 * docker start can change the bridge IP. If the machine is gone (evicted, host wiped) the
 * cold path runs unchanged: create a fresh machine and restore the latest snapshot.
 *
 * The warm path is FORCED COLD when the caller asks for something the frozen container cannot
 * deliver: a resize (a different --type: the resource flags are baked at create) or
 * noEnv/scrub (the disk is not trusted to keep its credentials, so it must be restored
 * scrubbed). A driver without the suspend capability is always cold.
 *
 * A requested resize to a type whose usable bytes cannot hold the snapshot's contentSizeBytes
 * is rejected with 400 type_too_small. `noEnv:true` takes the scrub path, stubbed until P5.
 */
export async function resumeOri(
  deps: AppDeps,
  oriId: string,
  req: { type?: RequestableMachineType; noEnv?: boolean },
  now: Date,
): Promise<ResumeOutcome> {
  const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Not found" };
  if (row.state !== "archived") {
    return { ok: false, status: 409, code: "resume_failed", message: "The ori is not archived." };
  }

  const targetType = req.type ?? row.type as RequestableMachineType;
  const snap = await latestSnapshot(deps, oriId);
  if (snap?.contentSizeBytes != null && !fitsType(targetType, snap.contentSizeBytes)) {
    return {
      ok: false,
      status: 400,
      code: "type_too_small",
      message: "The ori's data would not fit the smaller disk.",
    };
  }

  await deps.db.update(oris).set({ state: "provisioning", updatedAt: now }).where(eq(oris.id, oriId));
  await emitOriEvent(deps.db, oriId, "ori.resuming");

  // Derived from the ori id, so a resume recovers exactly the tokens this ori had before —
  // there is nothing to carry over in memory, which is what used to break across a restart.
  const mt = machineToken(oriId);
  const at = agentToken(oriId);
  {
    // Rewrite the hashes unconditionally. They are already correct for any ori created since
    // tokens became derived, and writing them HEALS a ori minted with the old random tokens:
    // its stored hashes match a token nothing can reproduce, so inbound machine-token auth
    // would 401 forever otherwise.
    await deps.db
      .update(oris)
      .set({ machineTokenHash: sha256Hex(mt), agentTokenHash: sha256Hex(at) })
      .where(eq(oris.id, oriId));
  }

  // Warm or cold? Warm needs (a) a machine the stop kept on disk, (b) a driver that can
  // suspend, and (c) a request the frozen container can satisfy — no resize, no scrub. The
  // exists() probe is what separates "warm, just start it" from "gone, restore from restic";
  // a probe that cannot answer (docker hiccup) degrades to cold, never to a false warm start.
  const suspend = deps.driver as unknown as SuspendableDriver;
  const resize = req.type !== undefined && req.type !== row.type;
  const warmEligible = row.machineId != null && !resize && req.noEnv !== true;
  const canWarm = typeof suspend.start === "function" && typeof suspend.exists === "function";
  const warm = warmEligible && canWarm && (await suspend.exists(row.machineId!).catch(() => false));

  // Cold path, shared by every fallthrough: destroy any stale warm container (a resize/scrub
  // rebuilds the disk from restic anyway, and the fake driver would otherwise keep the dead
  // machine around), create fresh, and return the row's machineId/ip — or null on failure.
  const coldCreate = async (): Promise<{ machineId: string; ip: string } | null> => {
    if (row.machineId) await deps.driver.destroy(row.machineId).catch(() => {});
    try {
      return await deps.driver.create({
        oriId,
        type: targetType,
        image: BASE_IMAGE,
        machineToken: mt,
        agentToken: at,
      });
    } catch (e) {
      await deps.db
        .update(oris)
        .set({ state: "error", error: (e as Error).message, updatedAt: now })
        .where(eq(oris.id, oriId));
      await emitOriEvent(deps.db, oriId, "ori.error", { data: { error: (e as Error).message } });
      return null;
    }
  };

  let machineId: string;
  let ip: string;
  let resumedWarm = false;
  if (warm) {
    // A start failure (broken writable layer, a daemon blip) is treated as "the container is
    // worthless": fall through to cold, which destroys it (a no-op if the start failure already
    // removed it) and restores onto a fresh machine, rather than stranding the ori in
    // provisioning forever.
    const started = await suspend.start(row.machineId!).catch(() => null);
    if (started) {
      machineId = row.machineId!;
      ip = started.ip;
      resumedWarm = true;
    } else {
      const created = await coldCreate();
      if (!created) return { ok: false, status: 500, code: "internal_error", message: "Machine create failed." };
      machineId = created.machineId;
      ip = created.ip;
    }
  } else {
    const created = await coldCreate();
    if (!created) return { ok: false, status: 500, code: "internal_error", message: "Machine create failed." };
    machineId = created.machineId;
    ip = created.ip;
  }

  await deps.db
    .update(oris)
    .set({ machineId, ip, type: targetType, updatedAt: now })
    .where(eq(oris.id, oriId));

  // TTL clock resets from resume time. Recorded on the request path, like recordStart below,
  // so the 202 describes the resumed ori even while the slow restore is still running.
  const ttl = row.ttlSeconds;
  await deps.db
    .update(oris)
    .set({ archiveAfter: ttl ? new Date(now.getTime() + ttl * 1000) : null, updatedAt: now })
    .where(eq(oris.id, oriId));

  await recordStart(deps.db, row.userId, oriId, "resume", now);

  if (resumedWarm) {
    // No restore: the disk is already here, the container is already built. Provision (health
    // + env), then re-register edge routes the same way the cold path does after a successful
    // restore — stop tore them down and the container is serving again.
    void provisionToReady(deps, oriId)
      .then(() => reregisterAllPortRoutes(deps, oriId))
      .catch(() => {});
  } else if (snap) {
    const ref = snap.resticId ?? snap.id;
    await emitOriEvent(deps.db, oriId, "ori.restoring", { data: { snapshotRef: ref } });
    // onFailure archived: the snapshot is still there, so a failed resume must stay retryable
    // rather than stranding the ori in a terminal state it can never leave.
    void restoreThenProvision(deps, {
      oriId,
      machineId,
      snapshotRef: ref,
      scrubEnv: req.noEnv === true,
      onFailure: "archived",
    });
  } else {
    // Nothing to restore; the fresh machine can be provisioned directly.
    void provisionToReady(deps, oriId);
  }

  return { ok: true };
}
