import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore } from "./helpers";
import { assertValidResponse } from "../contract/harness";
import { oriEnv, oris, oriEvents } from "@ori/api/db/schema";
import { oriId, type Ori } from "@ori/contract";

const db = makeDb();
const driver = new FakeMachineDriver();
const tokens = new TokenStore();
const deps = { db, driver, tokens };
const app = buildApp(deps);

let key: Awaited<ReturnType<typeof seedUserKey>>;

const ORIS = "/api/ori/v1/oris";

/** Fresh user per test so the 10-create/min rate limit never trips mid-test. */
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

async function deleteOri(id: string): Promise<void> {
  await db.delete(oriEvents).where(eq(oriEvents.oriId, id));
  await db.delete(oriEnv).where(eq(oriEnv.oriId, id));
  await db.delete(oris).where(eq(oris.id, id));
}

beforeAll(async () => {
  key = await seedUserKey(db);
});

afterAll(async () => {
  await driver.stopAll();
  const delOris = await db.select({ id: oris.id }).from(oris).where(eq(oris.userId, key.userId));
    for (const b of delOris) { await db.delete(oriEvents).where(eq(oriEvents.oriId, b.id)); await db.delete(oris).where(eq(oris.id, b.id)); }
});

describe("T-P3-03 GET /oris/{oriId}", () => {
  test("returns ori.info for an owned ori, validating", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    const res = await app.request(`${ORIS}/${ori.id}`, {
      headers: { authorization: `Bearer ${k.secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("get", body);
    expect(body.type).toBe("ori.info");
    expect(body.ori.id).toBe(ori.id);
    expect(body.ori.state).toBe("ready");
    await deleteOri(ori.id);
  });

  test("404 for an unknown id", async () => {
    const k = await freshKey();
    const res = await app.request(`${ORIS}/or_99999999`, {
      headers: { authorization: `Bearer ${k.secret}` },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  test("404 for another user's ori", async () => {
    const u1 = await freshKey();
    const u2 = await freshKey();
    const ori = await create({}, u2.secret);
    const res = await app.request(`${ORIS}/${ori.id}`, {
      headers: { authorization: `Bearer ${u1.secret}` },
    });
    expect(res.status).toBe(404);
    // Wait for provisioning to finish before cleaning up. provisionToReady runs off the
    // request path and inserts a `ready` event; deleting mid-flight clears ori_events,
    // then the event lands, then the ori delete trips
    // ori_events_ori_id_oris_id_fk. That surfaced as this test "failing" -- the 404
    // assertion above always passed, the teardown threw -- and only when another file ran
    // first, because that shifts the timing enough to lose the race.
    await waitForState(ori.id, "ready");
    await deleteOri(ori.id);
  });

  test("requires auth", async () => {
    const res = await app.request(`${ORIS}/or_99999999`, {}, app);
    expect(res.status).toBe(401);
  });
});

describe("T-P3-03 GET /oris list", () => {
  const created: string[] = [];
  const key = { current: null as Awaited<ReturnType<typeof seedUserKey>> | null };

  beforeAll(async () => {
    key.current = await freshKey();
  });

  afterAll(async () => {
    for (const id of created) await deleteOri(id);
    created.length = 0;
    if (key.current) { const rows2 = await db.select({ id: oris.id }).from(oris).where(eq(oris.userId, key.current.userId)); for (const b of rows2) { await db.delete(oriEvents).where(eq(oriEvents.oriId, b.id)); await db.delete(oris).where(eq(oris.id, b.id)); } }
  });

  test("returns newest-first with pageInfo, validating", async () => {
    const a = await create({}, key.current!.secret);
    await waitForState(a.id, "ready");
    const b = await create({}, key.current!.secret);
    await waitForState(b.id, "ready");
    created.push(a.id, b.id);

    const res = await app.request(ORIS, { headers: { authorization: `Bearer ${key.current!.secret}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("oris", body);
    expect(body.type).toBe("ori.list");
    expect(body.pageInfo).toEqual({ nextCursor: null, hasMore: false, limit: 100 });
    // newest first: b was created after a
    expect(body.oris[0].id).toBe(b.id);
    expect(body.oris[1].id).toBe(a.id);
  });

  test("respects ?limit and exposes a working nextCursor", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ori = await create({}, key.current!.secret);
      await waitForState(ori.id, "ready");
      ids.push(ori.id);
      created.push(ori.id);
    }

    // Walk to exhaustion instead of asserting fixed page counts. The previous
    // version hard-coded pages of 2/2/1 and a total of 5, which passed only
    // because paginate() was dropping one row per boundary: this user owns 7
    // oris (2 from earlier tests here), and 7 - 2 dropped happened to equal the
    // 5 this test creates. It also asserted "no duplicates", which the bug never
    // produced. Neither assertion could see a row going missing.
    const pages: { ids: string[]; hasMore: boolean; nextCursor: string | null }[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const qs = new URLSearchParams({ limit: "2" });
      if (cursor) qs.set("cursor", cursor);
      const res = await app.request(`${ORIS}?${qs}`, {
        headers: { authorization: `Bearer ${key.current!.secret}` },
      });
      const body = await res.json();
      expect(body.oris.length).toBeLessThanOrEqual(2); // ?limit is respected
      pages.push({
        ids: (body.oris as Ori[]).map((x) => x.id),
        hasMore: body.pageInfo.hasMore,
        nextCursor: body.pageInfo.nextCursor,
      });
      if (!body.pageInfo.hasMore) {
        expect(body.pageInfo.nextCursor).toBeNull();
        break;
      }
      expect(typeof body.pageInfo.nextCursor).toBe("string");
      cursor = body.pageInfo.nextCursor;
    }

    expect(pages.length).toBeGreaterThan(1); // the cursor actually advanced
    const all = pages.flatMap((p) => p.ids);
    expect(new Set(all).size).toBe(all.length); // no row served twice
    for (const id of ids) expect(all).toContain(id); // and none silently dropped
  });

  test("does not leak another user's oris", async () => {
    const u2 = await freshKey();
    const foreign = await create({}, u2.secret);
    const res = await app.request(ORIS, { headers: { authorization: `Bearer ${key.current!.secret}` } });
    const body = await res.json();

    // Assert the foreign ori id is ABSENT. The previous assertion was
    // `expect(ori.id).not.toMatch(/leak/)` over the caller's own list, which no ori id
    // can ever match -- so a test named "does not leak another user's oris" could not
    // fail, and would have passed happily through an actual cross-tenant leak.
    const ids = (body.oris as Ori[]).map((b) => b.id);
    expect(ids).not.toContain(foreign.id);
    expect(ids.length).toBeGreaterThan(0); // the caller does see its own oris

    // Let provisioning finish before deleting, or the async `ready` event lands between
    // the ori_events delete and the oris delete and trips the FK.
    await waitForState(foreign.id, "ready");
    const u2Oris = await db.select({ id: oris.id }).from(oris).where(eq(oris.userId, u2.userId));
    for (const b of u2Oris) {
      await db.delete(oriEvents).where(eq(oriEvents.oriId, b.id));
      await db.delete(oris).where(eq(oris.id, b.id));
    }
  });
});

describe("T-P3-03 PATCH /oris/{oriId}", () => {
  test("renames a ori (name 1..120) and returns ori.info", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    const res = await app.request(`${ORIS}/${ori.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed ori" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("update", body);
    expect(body.ori.name).toBe("renamed ori");
    expect(body.ori.id).toBe(ori.id);
    await deleteOri(ori.id);
  });

  test("rejects an empty name", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    const res = await app.request(`${ORIS}/${ori.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
    await deleteOri(ori.id);
  });

  test("updates ttlSeconds and resets archiveAfter from now", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    const res = await app.request(`${ORIS}/${ori.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ ttlSeconds: 180 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.ttlSeconds).toBe(180);
    expect(new Date(body.ori.archiveAfter).getTime() - Date.now()).toBeLessThanOrEqual(180_000 + 60_000);
    expect(new Date(body.ori.archiveAfter).getTime() - Date.now()).toBeGreaterThanOrEqual(180_000 - 60_000);
    await deleteOri(ori.id);
  });

  test("sets a valid subdomain and rejects an invalid one", async () => {
    const k = await freshKey();
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");

    const good = await app.request(`${ORIS}/${ori.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ subdomain: `proj-${Date.now().toString(36)}` }),
    });
    expect(good.status).toBe(200);
    expect((await good.json()).ori.subdomain).toMatch(/^proj-/);

    const bad = await app.request(`${ORIS}/${ori.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ subdomain: "ends-with-desktop" }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("invalid_subdomain");
    await deleteOri(ori.id);
  });

  test("enforces subdomain uniqueness with 409 subdomain_taken", async () => {
    const k = await freshKey();
    const oriA = await create({}, k.secret);
    const oriB = await create({}, k.secret);
    await waitForState(oriA.id, "ready");
    await waitForState(oriB.id, "ready");
    const taken = `taken-${Date.now().toString(36)}`;

    await app.request(`${ORIS}/${oriA.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ subdomain: taken }),
    });
    const res = await app.request(`${ORIS}/${oriB.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ subdomain: taken }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("subdomain_taken");
    await deleteOri(oriA.id);
    await deleteOri(oriB.id);
  });

  test("404 for an unknown ori", async () => {
    const k = await freshKey();
    const res = await app.request(`${ORIS}/or_99999999`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });

  test("requires auth", async () => {
    const res = await app.request(
      `${ORIS}/or_99999999`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      app,
    );
    expect(res.status).toBe(401);
  });
});
