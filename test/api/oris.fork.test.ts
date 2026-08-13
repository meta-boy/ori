import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore } from "./helpers";
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

async function create(body: unknown = {}, secret = key.secret) {
  const res = await app.request(ORIS, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
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

async function fork(id: string, body: unknown = {}, secret = key.secret) {
  return app.request(`${ORIS}/${id}/fork`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function insertSnapshot(oriIdParam: string, opts: { generation?: number; contentSizeBytes?: number } = {}) {
  const id = snapshotId();
  await db.insert(snapshots).values({
    id,
    oriId: oriIdParam,
    generation: opts.generation ?? 1,
    kind: "base",
    status: "completed",
    sizeBytes: 1024 * 1024,
    fileCount: 10,
    contentSizeBytes: opts.contentSizeBytes ?? 1024 * 1024,
  });
  return id;
}

async function deleteOri(id: string): Promise<void> {
  await db.delete(oriEvents).where(eq(oriEvents.oriId, id));
  await db.delete(snapshots).where(eq(snapshots.oriId, id));
  await db.delete(oriEnv).where(eq(oriEnv.oriId, id));
  await db.delete(usageLedger).where(eq(usageLedger.oriId, id));
  await db.delete(startsLog).where(eq(startsLog.oriId, id));
  await db.delete(oris).where(eq(oris.id, id));
}

beforeAll(async () => {
  key = await seedUserKey(db);
});

afterAll(async () => {
  await driver.stopAll();
});

describe("T-P3-06 POST /oris/{oriId}/fork", () => {
  test("creates a new or_ id in cloning state, restores snapshot, validates", async () => {
    const k = await freshKey();
    const source = await create({}, k.secret);
    await waitForState(source.id, "ready");
    await insertSnapshot(source.id);
    await stop(source.id, k.secret);
    await waitForState(source.id, "archived");

    const res = await fork(source.id, {}, k.secret);
    expect(res.status).toBe(202);
    const body = await res.json();
    assertValidResponse("fork", body);
    expect(body.type).toBe("ori.forking");
    expect(body.id).not.toBe(source.id);
    expect(body.id).toMatch(/^or_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);

    const forked = body.ori;
    expect(forked.id).toBe(body.id);
    await waitForState(body.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, body.id) });
    expect(row?.state).toBe("ready");
    expect(row?.userId).toBe(k.userId);
    // source untouched
    const srcRow = await db.query.oris.findFirst({ where: eq(oris.id, source.id) });
    expect(srcRow?.state).toBe("archived");
    await deleteOri(body.id);
    await deleteOri(source.id);
  });

  test("restores the source's latest snapshot through the guest agent", async () => {
    const k = await freshKey();
    const source = await create({}, k.secret);
    await waitForState(source.id, "ready");
    const snapId = await insertSnapshot(source.id);
    await stop(source.id, k.secret);
    await waitForState(source.id, "archived");

    const res = await fork(source.id, {}, k.secret);
    const forkedId = (await res.json()).id;
    await waitForState(forkedId, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, forkedId) });
    const guest = driver.guest(row!.machineId!)!;
    expect(guest.lastRestore?.snapshotRef).toBe(snapId);
    await deleteOri(forkedId);
    await deleteOri(source.id);
  });

  test("a failed restore still reaches the client: state error + ori.restore_failed event", async () => {
    const k = await freshKey();
    const source = await create({}, k.secret);
    await waitForState(source.id, "ready");
    await insertSnapshot(source.id);
    await stop(source.id, k.secret);
    await waitForState(source.id, "archived");

    const res = await fork(source.id, {}, k.secret);
    expect(res.status).toBe(202);
    const forkedId = (await res.json()).id;
    // The restore now runs in the background, so the failure is only observable through
    // state + events, not the HTTP response. Grab the freshly created guest before its
    // restore call lands (the background task is mid-flight: DB read + storage-cred mint).
    const row = await db.query.oris.findFirst({ where: eq(oris.id, forkedId) });
    driver.guest(row!.machineId!)!.failRestore = true;

    await waitForState(forkedId, "error");
    const failed = await db.query.oris.findFirst({ where: eq(oris.id, forkedId) });
    expect(failed?.error).toContain("restore failed");
    // the half-built fork is torn down, exactly like the old synchronous path
    expect(failed?.machineId).toBeNull();
    const events = await db.select().from(oriEvents).where(eq(oriEvents.oriId, forkedId));
    const restoreFailed = events.find((e) => e.type === "ori.restore_failed");
    expect(restoreFailed).toBeDefined();
    expect((restoreFailed!.data as { reason?: unknown }).reason).toBe("injected restore failure");
    await deleteOri(forkedId);
    await deleteOri(source.id);
  });

  test("inherits the source's env unless noEnv", async () => {
    const k = await freshKey();
    const source = await create({ env: { FOO: "bar", BAZ: "qux" } }, k.secret);
    await waitForState(source.id, "ready");
    await insertSnapshot(source.id);
    await stop(source.id, k.secret);
    await waitForState(source.id, "archived");

    const res = await fork(source.id, {}, k.secret);
    const forkedId = (await res.json()).id;
    await waitForState(forkedId, "ready");
    const envRows = await db.select().from(oriEnv).where(eq(oriEnv.oriId, forkedId));
    expect(envRows.map((r) => [r.key, r.value]).sort()).toEqual([
      ["BAZ", "qux"],
      ["FOO", "bar"],
    ]);
    await deleteOri(forkedId);
    await deleteOri(source.id);
  });

  test("noEnv fork stays noEnv but inherits the source's per-box env", async () => {
    // A noEnv fork withholds ACCOUNT secrets; per-box env is not an account secret, so the
    // fork keeps it (Box: "Forks inherit the source's per-box env ... a fork of a no-env box
    // is always no-env").
    const k = await freshKey();
    const source = await create({ env: { FOO: "bar" } }, k.secret);
    await waitForState(source.id, "ready");
    await insertSnapshot(source.id);
    await stop(source.id, k.secret);
    await waitForState(source.id, "archived");

    const res = await fork(source.id, { noEnv: true }, k.secret);
    const forkedId = (await res.json()).id;
    await waitForState(forkedId, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, forkedId) });
    expect(row?.noEnv).toBe(true);
    const envRows = await db.select().from(oriEnv).where(eq(oriEnv.oriId, forkedId));
    expect(envRows).toHaveLength(1);
    expect(envRows[0].key).toBe("FOO");
    await deleteOri(forkedId);
    await deleteOri(source.id);
  });

  test("a fork of a noEnv source is always noEnv", async () => {
    const k = await freshKey();
    const source = await create({ env: { FOO: "bar" }, noEnv: true }, k.secret);
    await waitForState(source.id, "ready");
    await insertSnapshot(source.id);
    await stop(source.id, k.secret);
    await waitForState(source.id, "archived");

    const res = await fork(source.id, {}, k.secret);
    const forkedId = (await res.json()).id;
    await waitForState(forkedId, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, forkedId) });
    expect(row?.noEnv).toBe(true);
    await deleteOri(forkedId);
    await deleteOri(source.id);
  });

  test("explicit fork env replaces the inherited one", async () => {
    const k = await freshKey();
    const source = await create({ env: { FOO: "bar" } }, k.secret);
    await waitForState(source.id, "ready");
    await insertSnapshot(source.id);
    await stop(source.id, k.secret);
    await waitForState(source.id, "archived");

    const res = await fork(source.id, { env: { OWN: "1" } }, k.secret);
    const forkedId = (await res.json()).id;
    await waitForState(forkedId, "ready");
    const envRows = await db.select().from(oriEnv).where(eq(oriEnv.oriId, forkedId));
    expect(envRows.map((r) => [r.key, r.value])).toEqual([["OWN", "1"]]);
    await deleteOri(forkedId);
    await deleteOri(source.id);
  });

  test("the source may be archived (ready source forks too)", async () => {
    const k = await freshKey();
    const source = await create({}, k.secret);
    await waitForState(source.id, "ready");
    await insertSnapshot(source.id);

    // source is still ready, not archived
    const res = await fork(source.id, {}, k.secret);
    expect(res.status).toBe(202);
    const forkedId = (await res.json()).id;
    await waitForState(forkedId, "ready");
    await deleteOri(forkedId);
    await deleteOri(source.id);
  });

  test("inherits the source's machine type and size unless overridden", async () => {
    const k = await freshKey();
    const source = await create({ type: "large" }, k.secret);
    await waitForState(source.id, "ready");
    await insertSnapshot(source.id);
    await stop(source.id, k.secret);
    await waitForState(source.id, "archived");

    const res = await fork(source.id, {}, k.secret);
    const forkedId = (await res.json()).id;
    await waitForState(forkedId, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, forkedId) });
    expect(row?.type).toBe("large");
    await deleteOri(forkedId);
    await deleteOri(source.id);
  });

  test("rejects a shrink to small with 400 type_too_small when content exceeds usableGB", async () => {
    const k = await freshKey();
    const source = await create({}, k.secret);
    await waitForState(source.id, "ready");
    await insertSnapshot(source.id, { contentSizeBytes: usableBytes("small") + 1 });
    await stop(source.id, k.secret);
    await waitForState(source.id, "archived");

    const res = await fork(source.id, { type: "small" }, k.secret);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("type_too_small");
    await deleteOri(source.id);
  });

  test("counts as a machine start", async () => {
    const k = await freshKey();
    const source = await create({}, k.secret);
    await waitForState(source.id, "ready");
    await insertSnapshot(source.id);
    await stop(source.id, k.secret);
    await waitForState(source.id, "archived");

    await fork(source.id, {}, k.secret);
    const rows = await db.select().from(startsLog).where(eq(startsLog.userId, k.userId));
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain("fork");
    await db.delete(startsLog).where(eq(startsLog.userId, k.userId));
    await deleteOri(source.id);
  });

  test("404 for an unknown or another user's ori", async () => {
    const k = await freshKey();
    const other = await freshKey();
    const ori = await create({}, other.secret);
    await waitForState(ori.id, "ready");
    await insertSnapshot(ori.id);

    expect((await fork("or_99999999", {}, k.secret)).status).toBe(404);
    expect((await fork(ori.id, {}, k.secret)).status).toBe(404);
    await deleteOri(ori.id);
  });

  test("requires auth", async () => {
    const res = await app.request(
      `${ORIS}/or_99999999/fork`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      app,
    );
    expect(res.status).toBe(401);
  });
});
