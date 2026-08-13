import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { oriEnv, oriEvents, oris, snapshots, usageLedger } from "@ori/api/db/schema";
import { buildApp, buildDeps, seedUserKey, uniq } from "./helpers";
import type { SuspendableDriver } from "@ori/api/drivers/types";

/**
 * DELETE /oris/{id} — the only operation that destroys snapshot data.
 *
 * The object-store half is exercised by the e2e suites against a real minio; here the
 * assertions are about what the database looks like afterwards, because that is where the
 * subtle mistakes live: a forgotten child table makes the delete fail on a foreign key, and
 * deleting the usage ledger silently rewrites billing history.
 */
const deps = buildDeps();
const app = buildApp(deps);

async function seedOri(userId: string, over: Partial<typeof oris.$inferInsert> = {}) {
  const id = uniq("or_");
  await deps.db.insert(oris).values({
    id,
    userId,
    name: "delete-me",
    state: "archived",
    type: "small",
    machineTokenHash: "h",
    agentTokenHash: "h",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
  return id;
}

describe("DELETE /oris/{oriId}", () => {
  test("removes the ori, its children, and reports what it deleted", async () => {
    const { userId, secret: key } = await seedUserKey(deps.db);
    const id = await seedOri(userId);
    await deps.db.insert(oriEnv).values({ oriId: id, key: "K", value: "v" });
    await deps.db.insert(oriEvents).values({ oriId: id, type: "ori.created", timestamp: Date.now() });
    await deps.db.insert(snapshots).values({ id: crypto.randomUUID(), oriId: id, generation: 1, status: "completed" });

    const res = await app.request(`/api/ori/v1/oris/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.snapshotsDeleted).toBe(1);

    expect(await deps.db.query.oris.findFirst({ where: eq(oris.id, id) })).toBeUndefined();
    expect(await deps.db.select().from(snapshots).where(eq(snapshots.oriId, id))).toHaveLength(0);
    expect(await deps.db.select().from(oriEnv).where(eq(oriEnv.oriId, id))).toHaveLength(0);
    expect(await deps.db.select().from(oriEvents).where(eq(oriEvents.oriId, id))).toHaveLength(0);
  });

  test("keeps billing history, detached — deleting a ori must not rewrite what was charged", async () => {
    const { userId, secret: key } = await seedUserKey(deps.db);
    const id = await seedOri(userId);
    await deps.db.insert(usageLedger).values({
      userId,
      oriId: id,
      fromTs: new Date(Date.now() - 60_000),
      toTs: new Date(),
      seconds: 60,
      multiplier: 0.5,
      machineSeconds: 30,
    });

    const res = await app.request(`/api/ori/v1/oris/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);

    const ledger = await deps.db.select().from(usageLedger).where(eq(usageLedger.userId, userId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.oriId).toBeNull();
    expect(ledger[0]!.seconds).toBe(60);
    expect(ledger[0]!.machineSeconds).toBe(30);
  });

  test("refuses while the ori is still active — stop owns the snapshot and the billing close", async () => {
    const { userId, secret: key } = await seedUserKey(deps.db);
    const id = await seedOri(userId, { state: "ready" });

    const res = await app.request(`/api/ori/v1/oris/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ori_not_deletable");
    expect(await deps.db.query.oris.findFirst({ where: eq(oris.id, id) })).toBeDefined();
  });

  test("reclaims a warm container's disk before the row goes", async () => {
    const { userId, secret: key } = await seedUserKey(deps.db);
    // A warm (archived, stopped-but-on-disk) ori: the row still points at a machine. Deleting
    // the ori must destroy that container — the row is about to forget it, so the disk would
    // otherwise leak forever.
    const machine = await deps.driver.create({
      oriId: "or_warm_delete",
      type: "default",
      image: "ubuntu-24.04",
      machineToken: "mt",
      agentToken: "at",
    });
    const id = await seedOri(userId, { machineId: machine.machineId });

    const res = await app.request(`/api/ori/v1/oris/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);

    expect(await (deps.driver as unknown as SuspendableDriver).exists(machine.machineId)).toBe(false); // container destroyed
    expect(await deps.db.query.oris.findFirst({ where: eq(oris.id, id) })).toBeUndefined();
  });

  test("another user's ori is a 404, not a 403 — existence is not disclosed", async () => {
    const owner = await seedUserKey(deps.db);
    const stranger = await seedUserKey(deps.db);
    const id = await seedOri(owner.userId);

    const res = await app.request(`/api/ori/v1/oris/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${stranger.secret}` },
    });
    expect(res.status).toBe(404);
    expect(await deps.db.query.oris.findFirst({ where: eq(oris.id, id) })).toBeDefined();
  });
});
