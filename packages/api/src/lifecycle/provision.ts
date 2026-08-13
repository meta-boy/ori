import { and, eq, inArray } from "drizzle-orm";
import { oris } from "../db/schema";
import type { AppDeps } from "../context";
import { GuestClient } from "../guest/client";
import { applyEnvToOri } from "./applyEnv";
import { emitOriEvent } from "./events";

/**
 * Wait until a freshly created machine's guest agent answers /health. Returns false if it never
 * does, so the caller decides what a dead guest means.
 *
 * Separate from `provisionToReady` because the restore path needs the precondition WITHOUT the
 * state flip. A machine created seconds ago has systemd up but `ori-agent.service` not yet
 * listening on :7777, and dialling it inside that window is what turned every fork and every
 * cold resume into a permanent `error`: measured on a Proxmox LXC host, the agent answered
 * 6-8s after create while the restore dialled it at ~0s and reported
 * `guest POST /restore: unreachable`.
 */
export async function waitForGuestHealth(
  deps: AppDeps,
  oriId: string,
  opts: { deadlineMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const { deadlineMs = 30_000, pollMs = 250 } = opts;
  const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  if (!row?.ip) return false;
  const tokens = deps.tokens.get(oriId);
  if (!tokens) return false;
  const guest = GuestClient.forIp(row.ip, tokens.agentToken);

  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      if ((await guest.health()).ok) return true;
    } catch {
      // Connection refused is the normal answer for the first few seconds of a machine's life.
    }
    if (Date.now() + pollMs >= deadline) return false;
    await Bun.sleep(pollMs);
  }
}

/**
 * Poll the ori's guest agent until it answers /health, then flip the ori to
 * `ready`. Runs off the request path after create/resume/fork; a ori whose
 * guest never becomes healthy stays in its pre-ready state for the reaper
 * (T-P3-08) to deal with. `fromStates` limits which states this may flip from
 * (create/resume use `provisioning`; fork uses `cloning`). `deadlineMs` is a
 * safety valve, not a guarantee of success.
 */
export async function provisionToReady(
  deps: AppDeps,
  oriId: string,
  opts: { deadlineMs?: number; pollMs?: number; fromStates?: readonly string[] } = {},
): Promise<void> {
  const { deadlineMs = 10_000, pollMs = 100, fromStates = ["provisioning"] } = opts;
  const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  if (!row || !(fromStates as readonly string[]).includes(row.state) || !row.ip) return;

  const tokens = deps.tokens.get(oriId);
  if (!tokens) return;
  const guest = GuestClient.forIp(row.ip, tokens.agentToken);

  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const health = await guest.health();
      if (health.ok) {
        // The effective environment is part of "ready": account secrets + per-box env are
        // pushed before the ori is usable. The guest just answered /health, so a failure
        // here is a blip rather than a boot delay — retry a FIXED few times instead of
        // burning the rest of the provisioning deadline (a permanent failure, e.g. missing
        // tokens, would otherwise sleep out the whole budget on every create). A persistent
        // failure still flips ready — a usable box without secrets beats a box stuck in
        // provisioning — and is recorded as an event so it is visible and re-pushable via
        // POST /secrets.
        let env = await applyEnvToOri(deps, oriId);
        for (let attempt = 0; !env.ok && attempt < 2; attempt++) {
          await Bun.sleep(pollMs);
          env = await applyEnvToOri(deps, oriId);
        }
        // Flip to ready and emit ori.ready in ONE transaction: if the ori was
        // concurrently deleted, the update affects no rows and no event is
        // written, so no orphan ori_events row is ever left to block a later
        // cleanup (test teardown) or violate the FK.
        await deps.db.transaction(async (tx) => {
          const updated = await tx
            .update(oris)
            .set({ state: "ready", updatedAt: new Date() })
            .where(and(eq(oris.id, oriId), inArray(oris.state, fromStates)))
            .returning({ id: oris.id });
          if (updated.length > 0) {
            await emitOriEvent(tx, oriId, "ori.ready");
          }
        });
        if (!env.ok) {
          await emitOriEvent(deps.db, oriId, "ori.env_failed", { data: { reason: env.reason } });
        }
        return;
      }
    } catch {
      // guest not answering yet; keep polling
    }
    await Bun.sleep(pollMs);
  }
}
