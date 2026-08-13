import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore } from "./helpers";
import { assertValidResponse } from "../contract/harness";
import { oriEnv, oris, oriEvents, snapshots, startsLog, usageLedger } from "@ori/api/db/schema";
import { snapshotId, type Ori } from "@ori/contract";

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
    body: "{}",
  });
  expect(res.status).toBe(202);
}

async function resume(id: string, secret = key.secret) {
  const res = await app.request(`${ORIS}/${id}/resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(202);
}

async function fork(id: string, secret = key.secret) {
  const res = await app.request(`${ORIS}/${id}/fork`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(202);
  return (await res.json()).id as string;
}

async function insertSnapshot(oriIdParam: string) {
  await db.insert(snapshots).values({
    id: snapshotId(),
    oriId: oriIdParam,
    generation: 1,
    kind: "base",
    status: "completed",
    sizeBytes: 1024 * 1024,
    fileCount: 10,
    contentSizeBytes: 1024 * 1024,
  });
}

async function deleteOri(id: string): Promise<void> {
  await db.delete(oriEvents).where(eq(oriEvents.oriId, id));
  await db.delete(snapshots).where(eq(snapshots.oriId, id));
  await db.delete(oriEnv).where(eq(oriEnv.oriId, id));
  await db.delete(usageLedger).where(eq(usageLedger.oriId, id));
  await db.delete(startsLog).where(eq(startsLog.oriId, id));
  await db.delete(oris).where(eq(oris.id, id));
}

async function fetchEvents(id: string, secret: string, qs = "?sort=asc") {
  const res = await app.request(`${ORIS}/${id}/events${qs}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  assertValidResponse("events", body);
  return body as { id: string; events: { type: string; id?: string; timestamp?: number; taskId?: string | null; data?: Record<string, unknown> }[]; pageInfo: { nextCursor: string | null; followCursor: string | null; hasMore: boolean; limit: number } };
}

beforeAll(async () => {
  key = await seedUserKey(db);
});

afterAll(async () => {
  await driver.stopAll();
});

describe("T-P3-07 event wiring", () => {
  test("create emits ori.created then ori.ready, in order", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    const body = await fetchEvents(ori.id, k.secret);
    expect(body.events.map((e) => e.type)).toEqual(["ori.created", "ori.ready"]);
    await deleteOri(ori.id);
  });

  test("fork emits ori.cloning then ori.ready on the new ori", async () => {
    const k = await freshKey();
    const source = await create({}, k.secret);
    await waitForState(source.id, "ready");
    await insertSnapshot(source.id);
    const forkedId = await fork(source.id, k.secret);
    await waitForState(forkedId, "ready");
    const body = await fetchEvents(forkedId, k.secret);
    expect(body.events.map((e) => e.type)).toEqual(["ori.cloning", "ori.ready"]);
    await deleteOri(forkedId);
    await deleteOri(source.id);
  });

  test("stop emits ori.archiving then ori.archived", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");
    const body = await fetchEvents(ori.id, k.secret);
    expect(body.events.map((e) => e.type)).toEqual(["ori.created", "ori.ready", "ori.archiving", "ori.archived"]);
    await deleteOri(ori.id);
  });

  test("resume emits resuming, restoring, then ready after archived", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    await insertSnapshot(ori.id);
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");
    // Force the cold path so a restore actually runs and emits ori.restoring: the default warm
    // resume (kept container still on disk) starts in place and skips restore.
    const stopped = (await db.query.oris.findFirst({ where: eq(oris.id, ori.id) }))!;
    await driver.destroy(stopped.machineId!);
    await resume(ori.id, k.secret);
    await waitForState(ori.id, "ready");
    const body = await fetchEvents(ori.id, k.secret);
    expect(body.events.map((e) => e.type)).toEqual([
      "ori.created",
      "ori.ready",
      "ori.archiving",
      "ori.archived",
      "ori.resuming",
      "ori.restoring",
      "ori.ready",
    ]);
    await deleteOri(ori.id);
  });

  test("full lifecycle: create, fork, stop produce the complete stream on both oris", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    await insertSnapshot(ori.id);
    const forkedId = await fork(ori.id, k.secret);
    await waitForState(forkedId, "ready");
    await stop(forkedId, k.secret);
    await waitForState(forkedId, "archived");

    const sourceBody = await fetchEvents(ori.id, k.secret);
    const forkBody = await fetchEvents(forkedId, k.secret);
    expect(sourceBody.events.map((e) => e.type)).toEqual(["ori.created", "ori.ready"]);
    expect(forkBody.events.map((e) => e.type)).toEqual([
      "ori.cloning",
      "ori.ready",
      "ori.archiving",
      "ori.archived",
    ]);
    await deleteOri(forkedId);
    await deleteOri(ori.id);
  });

  test("stop_failed is emitted when the final snapshot fails and the stop is refused", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    driver.guest(row!.machineId!)!.failSnapshot = true;
    const res = await app.request(`${ORIS}/${ori.id}/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(500);
    const body = await fetchEvents(ori.id, k.secret);
    expect(body.events.map((e) => e.type)).toEqual([
      "ori.created",
      "ori.ready",
      "ori.archiving",
      "ori.stop_failed",
    ]);
    await deleteOri(ori.id);
  });
});

describe("T-P3-07 GET /oris/{oriId}/events pagination", () => {
  test("pages through more events than one page holds, newest-first by default", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    // direct-write a handful of extra events so we exceed the page size
    const extra = ["event.a", "event.b", "event.c", "event.d", "event.e", "event.f"];
    for (const t of extra) {
      await db.insert(oriEvents).values({
        oriId: ori.id,
        type: t,
        timestamp: Date.now(),
        data: {},
      });
    }

    const page1 = await fetchEvents(ori.id, k.secret, "?limit=3");
    expect(page1.events).toHaveLength(3);
    expect(page1.pageInfo.hasMore).toBe(true);
    expect(typeof page1.pageInfo.nextCursor).toBe("string");

    const page2 = await fetchEvents(ori.id, k.secret, `?limit=3&cursor=${encodeURIComponent(page1.pageInfo.nextCursor!)}`);
    expect(page2.events).toHaveLength(3);
    expect(page2.pageInfo.hasMore).toBe(true);

    const page3 = await fetchEvents(ori.id, k.secret, `?limit=3&cursor=${encodeURIComponent(page2.pageInfo.nextCursor!)}`);
    expect(page3.events).toHaveLength(2);
    expect(page3.pageInfo.hasMore).toBe(false);
    expect(page3.pageInfo.nextCursor).toBeNull();

    // followCursor keeps working where nextCursor stops: on the LAST page it still points
    // past the newest event, which is how `ori events --follow` streams what arrives next.
    const tail = await fetchEvents(ori.id, k.secret, `?limit=3&sort=asc&cursor=${encodeURIComponent((await fetchEvents(ori.id, k.secret, "?limit=100&sort=asc")).pageInfo.followCursor!)}`);
    expect(tail.events).toHaveLength(0);
    await db.insert(oriEvents).values({ oriId: ori.id, type: "ori.after", timestamp: Date.now(), data: {} });
    const afterTail = await fetchEvents(ori.id, k.secret, `?limit=3&sort=asc&cursor=${encodeURIComponent(tail.pageInfo.followCursor!)}`);
    expect(afterTail.events.map((e) => e.type)).toEqual(["ori.after"]);

    const all = [...page1.events, ...page2.events, ...page3.events].map((e) => e.type);
    expect(all).toHaveLength(8);
    expect(new Set(all).size).toBe(all.length);
    // default sort=desc: newest first, so the manual writes precede the lifecycle events
    expect(all.slice(0, 6)).toEqual([...extra].reverse());
    expect(all.slice(6)).toEqual(["ori.ready", "ori.created"]);
    await deleteOri(ori.id);
  });

  test("sort=asc returns the stream in chronological order", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    const body = await fetchEvents(ori.id, k.secret, "?sort=asc");
    expect(body.events.map((e) => e.type)).toEqual(["ori.created", "ori.ready"]);
    await deleteOri(ori.id);
  });

  test("supports a comma-separated type filter", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    const body = await fetchEvents(ori.id, k.secret, "?type=ori.ready");
    expect(body.events.map((e) => e.type)).toEqual(["ori.ready"]);
    await deleteOri(ori.id);
  });

  test("404 for an unknown or another user's ori", async () => {
    const k = await freshKey();
    const other = await freshKey();
    const ori = await create({}, other.secret);
    await waitForState(ori.id, "ready");
    expect((await app.request(`${ORIS}/or_99999999/events`, { headers: { authorization: `Bearer ${k.secret}` } })).status).toBe(404);
    expect((await app.request(`${ORIS}/${ori.id}/events`, { headers: { authorization: `Bearer ${k.secret}` } })).status).toBe(404);
    await deleteOri(ori.id);
  });

  test("requires auth", async () => {
    const res = await app.request(`${ORIS}/or_99999999/events`, {}, app);
    expect(res.status).toBe(401);
  });
});
