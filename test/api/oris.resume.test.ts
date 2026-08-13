import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore } from "./helpers";
import { deleteOriCascade } from "./helpers";
import { assertValidResponse } from "../contract/harness";
import { oriEnv, oris, oriEvents, snapshots, startsLog, usageLedger } from "@ori/api/db/schema";
import { oriId, snapshotId, usableBytes, type Ori } from "@ori/contract";

const db = makeDb();
const driver = new FakeMachineDriver();
const tokens = new TokenStore();
const deps = { db, driver, tokens };
const app = buildApp(deps);

let key: Awaited<ReturnType<typeof seedUserKey>>;

const ORIS = "/api/ori/v1/oris";

async function freshKey() {
  return seedUserKey(db);
}

async function create(secret = key.secret) {
  const res = await app.request(ORIS, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
  });
  const json = await res.json();
  expect(json.ok).toBe(true);
  return json.ori as Ori;
}

async function waitForState(id: string, state: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    if (row?.state === state) return;
    await Bun.sleep(20);
  }
  throw new Error(`ori ${id} never reached ${state}`);
}

async function stop(id: string, secret = key.secret) {
  const res = await app.request(`${ORIS}/${id}/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    // force:true so stop does NOT take its own final snapshot. These tests seed a specific
    // snapshot and assert it is the one restored (or that its size trips type_too_small);
    // a real final snapshot would legitimately become the newest and displace it, testing
    // the wrong thing. The blocking-final-snapshot path has its own coverage in
    // test/api/snapshots/cadence.test.ts.
    body: JSON.stringify({ force: true }),
  });
  expect(res.status).toBe(202);
}

async function resume(id: string, body: unknown = {}, secret = key.secret) {
  return app.request(`${ORIS}/${id}/resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function insertSnapshot(oriIdParam: string, opts: { generation?: number; contentSizeBytes?: number } = {}) {
  await db.insert(snapshots).values({
    id: snapshotId(),
    oriId: oriIdParam,
    generation: opts.generation ?? 1,
    kind: "base",
    status: "completed",
    sizeBytes: 1024 * 1024,
    fileCount: 10,
    contentSizeBytes: opts.contentSizeBytes ?? 1024 * 1024,
  });
}

async function deleteOri(id: string): Promise<void> {
  await deleteOriCascade(db, id);
}

beforeAll(async () => {
  key = await seedUserKey(db);
});

afterAll(async () => {
  await driver.stopAll();
});

describe("T-P3-05 POST /oris/{oriId}/resume", () => {
  test("archived -> provisioning -> ready (warm: starts the kept container in place)", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const machineIdBefore = (await db.query.oris.findFirst({ where: eq(oris.id, ori.id) }))!.machineId;
    await insertSnapshot(ori.id);
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");

    const createdCountBefore = driver.createdCount;
    const res = await resume(ori.id, {}, k.secret);
    expect(res.status).toBe(202);
    const body = await res.json();
    assertValidResponse("resume", body);
    expect(body.type).toBe("ori.resuming");
    expect(body.id).toBe(ori.id);
    expect(body.status).toBe("resuming");

    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.state).toBe("ready");
    // Warm resume: the SAME container is started in place. No create, no restore — which is
    // the whole point (sub-second vs a multi-minute restic restore).
    expect(row?.machineId).toBe(machineIdBefore);
    expect(driver.createdCount).toBe(createdCountBefore);
    expect(row?.ip).not.toBeNull();
    expect(await driver.isAlive(row!.machineId!)).toBe(true);
    await deleteOri(ori.id);
  });

  test("cold fallback when the warm container is gone: create fresh machine and restore", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const machineIdBefore = (await db.query.oris.findFirst({ where: eq(oris.id, ori.id) }))!.machineId;
    await insertSnapshot(ori.id);
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");
    // Simulate the container having been evicted (reaper) or the host wiped: the row still
    // points at a machine that no longer exists, exactly the state the exists() probe sees.
    await driver.destroy(machineIdBefore!);

    const createdCountBefore = driver.createdCount;
    const res = await resume(ori.id, {}, k.secret);
    expect(res.status).toBe(202);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.state).toBe("ready");
    expect(row?.machineId).not.toBe(machineIdBefore);
    expect(driver.createdCount).toBe(createdCountBefore + 1);
    expect(await driver.isAlive(row!.machineId!)).toBe(true);
    await deleteOri(ori.id);
  });

  test("cold resume restores the latest snapshot through the guest agent", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const snap = snapshotId();
    await db.insert(snapshots).values({
      id: snap,
      oriId: ori.id,
      generation: 1,
      kind: "base",
      status: "completed",
      sizeBytes: 1024 * 1024,
      fileCount: 10,
      contentSizeBytes: 1024 * 1024,
    });
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");
    // Force the cold path: destroy the kept container so the exists() probe answers false and
    // resume must create fresh + restore. Warm resume (covered elsewhere) skips restore.
    const stopped = (await db.query.oris.findFirst({ where: eq(oris.id, ori.id) }))!;
    await driver.destroy(stopped.machineId!);

    await resume(ori.id, {}, k.secret);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    const guest = driver.guest(row!.machineId!)!;
    expect(guest.lastRestore?.snapshotRef).toBe(snap);
    expect(guest.lastRestore?.scrubEnv).toBe(false);
    await deleteOri(ori.id);
  });

  test("noEnv:true takes the scrub path (stub passes scrubEnv to restore)", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await insertSnapshot(ori.id);
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");

    const res = await resume(ori.id, { noEnv: true }, k.secret);
    expect(res.status).toBe(202);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    const guest = driver.guest(row!.machineId!)!;
    expect(guest.lastRestore?.scrubEnv).toBe(true);
    await deleteOri(ori.id);
  });

  // The state was `error` until a failed restore proved it should not be: the snapshot is
  // untouched, so the ori must land back where `resume` is legal and the caller can retry.
  // `ori.restore_failed` is still the record of what happened.
  test("a failed cold restore reaches the client: state archived + ori.restore_failed event", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await insertSnapshot(ori.id);
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");
    // Force the cold path so a restore actually runs (warm resume starts in place and skips it).
    const stopped = (await db.query.oris.findFirst({ where: eq(oris.id, ori.id) }))!;
    await driver.destroy(stopped.machineId!);

    const res = await resume(ori.id, {}, k.secret);
    expect(res.status).toBe(202);
    // The restore now runs in the background, so the failure is only observable through
    // state + events, not the HTTP response. Grab the freshly created guest before its
    // restore call lands (the background task is mid-flight: DB read + storage-cred mint).
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    driver.guest(row!.machineId!)!.failRestore = true;

    await waitForState(ori.id, "archived");
    const failed = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(failed?.error).toContain("restore failed");
    const events = await db.select().from(oriEvents).where(eq(oriEvents.oriId, ori.id));
    const restoreFailed = events.find((e) => e.type === "ori.restore_failed");
    expect(restoreFailed).toBeDefined();
    expect((restoreFailed!.data as { reason?: unknown }).reason).toBe("injected restore failure");
    await deleteOri(ori.id);
  });

  test("rejects a resize to small with 400 type_too_small when content exceeds usableGB", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await insertSnapshot(ori.id, { contentSizeBytes: usableBytes("small") + 1 });
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");

    const res = await resume(ori.id, { type: "small" }, k.secret);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("type_too_small");

    // ori stays archived
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.state).toBe("archived");
    await deleteOri(ori.id);
  });

  test("resize up to large succeeds when content fits", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await insertSnapshot(ori.id, { contentSizeBytes: usableBytes("default") - 1 });
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");

    const res = await resume(ori.id, { type: "large" }, k.secret);
    expect(res.status).toBe(202);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.type).toBe("large");
    await deleteOri(ori.id);
  });

  test("records a new machine start and resets the TTL clock", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await insertSnapshot(ori.id);
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");

    await resume(ori.id, {}, k.secret);
    await waitForState(ori.id, "ready");

    const rows = await db.select().from(startsLog).where(eq(startsLog.oriId, ori.id));
    expect(rows.map((r) => r.kind)).toContain("resume");

    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    const ttl = row!.ttlSeconds!;
    const expected = new Date(row!.updatedAt.getTime() + ttl * 1000);
    expect(new Date(row!.archiveAfter!).getTime()).toBeCloseTo(expected.getTime(), -3);
    await deleteOri(ori.id);
  });

  test("409 resume_failed for a non-archived ori", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");

    const res = await resume(ori.id, {}, k.secret);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("resume_failed");
    await deleteOri(ori.id);
  });

  test("404 for an unknown or another user's ori", async () => {
    const k = await freshKey();
    const other = await freshKey();
    const ori = await create(other.secret);
    await waitForState(ori.id, "ready");
    await insertSnapshot(ori.id);
    await stop(ori.id, other.secret);
    await waitForState(ori.id, "archived");

    expect((await resume("or_99999999", {}, k.secret)).status).toBe(404);
    expect((await resume(ori.id, {}, k.secret)).status).toBe(404);
    await deleteOri(ori.id);
  });

  // Regression: the restore used to dial the guest agent the instant the machine existed, so
  // on any host where the agent needs longer to listen than that dial, every cold resume and
  // every fork died on `guest POST /restore: unreachable` and was stranded in `error`.
  test("resume waits for a slow-booting guest agent instead of failing the restore", async () => {
    const ori = await create();
    await insertSnapshot(ori.id);
    await stop(ori.id);
    await waitForState(ori.id, "archived");

    // Force the cold path, or a warm resume starts in place and no restore runs at all.
    const stopped = (await db.query.oris.findFirst({ where: eq(oris.id, ori.id) }))!;
    await driver.destroy(stopped.machineId!);

    driver.nextGuestUnhealthyMs = 700;
    expect((await resume(ori.id)).status).toBe(202);
    await waitForState(ori.id, "ready", 4000);

    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.state).toBe("ready");
    await deleteOri(ori.id);
  });

  // A guest that never comes up must leave the ori where `resume` is still legal, because the
  // snapshot is untouched. Stranding it in `error` made one transient hiccup permanent.
  test("a resume whose guest never answers falls back to archived, not error", async () => {
    const previous = process.env.ORI_RESTORE_GUEST_WAIT_MS;
    process.env.ORI_RESTORE_GUEST_WAIT_MS = "300";
    try {
      const ori = await create();
      await insertSnapshot(ori.id);
      await stop(ori.id);
      await waitForState(ori.id, "archived");

      // Force the cold path, as above.
      const stopped = (await db.query.oris.findFirst({ where: eq(oris.id, ori.id) }))!;
      await driver.destroy(stopped.machineId!);

      driver.nextGuestUnhealthyMs = 2000;
      expect((await resume(ori.id)).status).toBe(202);
      await waitForState(ori.id, "archived", 3000);

      const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
      expect(row?.state).toBe("archived");
      expect(row?.error).toContain("restore failed");
      // Retryable: `resume` is legal from `archived`, so the next attempt is accepted.
      expect((await resume(ori.id)).status).toBe(202);
      await deleteOri(ori.id);
    } finally {
      if (previous === undefined) delete process.env.ORI_RESTORE_GUEST_WAIT_MS;
      else process.env.ORI_RESTORE_GUEST_WAIT_MS = previous;
    }
  });

  test("requires auth", async () => {
    const res = await app.request(
      `${ORIS}/or_99999999/resume`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      app,
    );
    expect(res.status).toBe(401);
  });
});
