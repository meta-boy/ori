import { and, eq } from "drizzle-orm";
import { applyAction, oriId, errorOf, fitsType, type OriState, type ErrorCode, type RequestableMachineType } from "@ori/contract";
import { oriEnv, oris } from "../db/schema";
import type { AppDeps } from "../context";
import { BASE_IMAGE } from "../constants";
import { agentToken, machineToken } from "../tokens";
import { sha256Hex } from "../middleware/auth";
import { recordStart } from "../rateLimit";
import { provisionToReady } from "./provision";
import { restoreThenProvision } from "./restore";
import { latestSnapshot } from "./resume";
import { restoreSnapshot } from "../snapshots/take";
import { emitOriEvent } from "./events";

export type ForkOutcome =
  | { ok: true; oriId: string }
  | { ok: false; status: 400 | 404 | 409 | 500; code: string; message: string };

/**
 * Fork a ori: snapshot-derived copy under a new or_ id. The source is never
 * modified and may be archived. The new ori inherits the source's latest
 * snapshot (restored through the guest agent), its env unless `noEnv`, and its
 * machine type unless overridden. A requested shrink that cannot hold the
 * snapshot's contentSizeBytes is rejected with 400 type_too_small.
 */
export async function forkOri(
  deps: AppDeps,
  sourceId: string,
  req: { env?: Record<string, string>; noEnv?: boolean; type?: RequestableMachineType },
  now: Date,
): Promise<ForkOutcome> {
  const source = await deps.db.query.oris.findFirst({ where: eq(oris.id, sourceId) });
  if (!source) return { ok: false, status: 404, code: "not_found", message: "Not found" };
  // Gate on the contract table: fork is legal from active and archived sources;
  // any other state (init, archiving, error) is rejected with the table's error.
  const gate = applyAction("fork", source.state as OriState);
  if (!gate.ok) {
    return { ok: false, status: errorOf(gate.code as ErrorCode).status as 400 | 404 | 409 | 500, code: gate.code, message: "The source ori cannot be forked in its current state." };
  }

  const targetType = req.type ?? (source.type as RequestableMachineType);
  const snap = await latestSnapshot(deps, sourceId);
  if (snap?.contentSizeBytes != null && !fitsType(targetType, snap.contentSizeBytes)) {
    return {
      ok: false,
      status: 400,
      code: "type_too_small",
      message: "The ori's data would not fit the smaller disk.",
    };
  }

  const id = oriId();
  const createdAt = now;
  const archiveAfter = source.ttlSeconds ? new Date(createdAt.getTime() + source.ttlSeconds * 1000) : null;
  const mt = machineToken(id);
  const at = agentToken(id);

  await deps.db.insert(oris).values({
    id,
    userId: source.userId,
    name: `Ori fork of ${source.name}`,
    state: "cloning",
    type: targetType,
    noEnv: source.noEnv || req.noEnv === true,
    // A fork is a copy: it gets the same desktop the parent had, or the same absence of one.
    display: source.display,
    machineTokenHash: sha256Hex(mt),
    agentTokenHash: sha256Hex(at),
    ttlSeconds: source.ttlSeconds,
    archiveAfter,
    createdAt,
    updatedAt: createdAt,
  });

  // Forks inherit the source's per-box env unless the fork request passes its own (Box docs:
  // "Forks inherit the source's per-box env unless the fork request passes its own (env on
  // fork is API and SDK only), and a fork of a no-env box is always no-env"). noEnv controls
  // whether ACCOUNT secrets reach the fork, not whether per-box env is copied.
  const env = req.env
    ? Object.entries(req.env).map(([key, value]) => ({ oriId: id, key, value }))
    : (await deps.db.select().from(oriEnv).where(eq(oriEnv.oriId, sourceId))).map((r) => ({
        oriId: id,
        key: r.key,
        value: r.value,
      }));
  if (env.length > 0) await deps.db.insert(oriEnv).values(env);

  deps.tokens.set(id, { machineToken: mt, agentToken: at });
  await emitOriEvent(deps.db, id, "ori.cloning");

  let machineId: string;
  let ip: string;
  try {
    const created = await deps.driver.create({
      oriId: id,
      type: targetType,
      image: BASE_IMAGE,
      machineToken: mt,
      agentToken: at,
    });
    machineId = created.machineId;
    ip = created.ip;
  } catch (e) {
    await deps.db
      .update(oris)
      .set({ state: "error", error: (e as Error).message, updatedAt: now })
      .where(eq(oris.id, id));
    await emitOriEvent(deps.db, id, "ori.error", { data: { error: (e as Error).message } });
    return { ok: false, status: 500, code: "internal_error", message: "Machine create failed." };
  }

  await deps.db.update(oris).set({ machineId, ip, updatedAt: now }).where(eq(oris.id, id));

  if (snap) {
    const ref = snap.resticId ?? snap.id;
    // The snapshot lives in the SOURCE ori's repository, so mint for source.id.
    void restoreThenProvision(deps, {
      oriId: id,
      machineId,
      snapshotRef: ref,
      scrubEnv: source.noEnv || req.noEnv === true,
      repoOriId: source.id,
      fromStates: ["cloning"],
    });
  } else {
    // Nothing to restore; the fresh machine can be provisioned directly.
    void provisionToReady(deps, id, { fromStates: ["cloning"] });
  }

  await recordStart(deps.db, source.userId, id, "fork", now);

  return { ok: true, oriId: id };
}
