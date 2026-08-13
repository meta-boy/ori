import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore, deleteOriCascade } from "./helpers";
import { oris, portRoutes, snapshots } from "@ori/api/db/schema";
import { oriId, snapshotId, type Ori } from "@ori/contract";
import { machineToken } from "@ori/api/tokens";
import type { RouteRegistrar, RouteTarget } from "@ori/api/edge/registrar";

/**
 * T-P12-07/08/14 — public hosting: `host <port>` registers a stable HTTPS URL, gates it
 * with a _token, teardown on stop/delete, re-registration on resume, and the edge
 * ask/validate endpoints. The registrar is a recording fake: tests assert what the edge is
 * told, without needing Caddy.
 */

class RecordingRegistrar implements RouteRegistrar {
  readonly enabled = true;
  added: RouteTarget[] = [];
  removed: string[] = [];
  async addRoute(t: RouteTarget): Promise<void> {
    this.added.push(t);
  }
  async removeRoute(hostname: string): Promise<void> {
    this.removed.push(hostname);
  }
}

const db = makeDb();
const driver = new FakeMachineDriver();
const tokens = new TokenStore();
const registrar = new RecordingRegistrar();
const deps = { db, driver, tokens, routes: registrar };
const app = buildApp(deps);

let key: Awaited<ReturnType<typeof seedUserKey>>;
const ORIS = "/api/ori/v1/oris";
const EDGE = "on.ori.dev";

async function create(secret = key.secret): Promise<Ori> {
  const res = await app.request(ORIS, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
  });
  const json = await res.json();
  expect(json.ok).toBe(true);
  return json.ori as Ori;
}

async function waitForState(id: string, state: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    if (row?.state === state) return;
    await Bun.sleep(20);
  }
  throw new Error(`ori ${id} never reached ${state}`);
}

async function register(id: string, body: unknown, secret = key.secret) {
  return app.request(`${ORIS}/${id}/routes`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function stop(id: string, secret = key.secret) {
  return app.request(`${ORIS}/${id}/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ force: true }),
  });
}

async function resume(id: string, secret = key.secret) {
  return app.request(`${ORIS}/${id}/resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
  });
}

async function insertSnapshot(id: string) {
  await db.insert(snapshots).values({
    id: snapshotId(),
    oriId: id,
    chainId: snapshotId(),
    generation: 1,
    kind: "base",
    status: "completed",
    createdAt: new Date(),
    completedAt: new Date(),
    sizeBytes: 1024,
    fileCount: 4,
    contentSizeBytes: 512,
    contentFileCount: 2,
    resticId: "fakerepo:deadbeef",
  });
}

beforeAll(async () => {
  key = await seedUserKey(db);
});

afterAll(async () => {
  await driver.stopAll();
});

describe("T-P12-07 port routes", () => {
  test("register: auto-assigns subdomain, returns a private token-gated URL", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const res = await register(ori.id, { port: 3000, title: "app" }, k.secret);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.hostname).toBe(`${body.subdomain}-3000.${EDGE}`);
    expect(body.url).toBe(`https://${body.hostname}`);
    expect(body.access).toBe("private");
    expect(body.isProtected).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.subdomain).toBe(`or${ori.id.replace("or_", "")}`);
    // The ori row now carries the subdomain and the registrar was told to add a gated route.
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.subdomain).toBe(body.subdomain);
    expect(registrar.added).toHaveLength(1);
    expect(registrar.added[0].hostname).toBe(body.hostname);
    expect(registrar.added[0].gate).toBe(true);
    await deleteOriCascade(db, ori.id);
    registrar.added = [];
    registrar.removed = [];
  });

  test("re-registering the same port returns the same URL and token (sticky)", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const a = (await (await register(ori.id, { port: 8080 }, k.secret)).json());
    const b = (await (await register(ori.id, { port: 8080 }, k.secret)).json());
    expect(b.url).toBe(a.url);
    expect(b.token).toBe(a.token);
    await deleteOriCascade(db, ori.id);
  });

  test("public route has no token", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const body = await (await register(ori.id, { port: 3001, public: true }, k.secret)).json();
    expect(body.isProtected).toBe(false);
    expect(body.access).toBe("public");
    expect(body.token).toBeNull();
    expect(registrar.added[registrar.added.length - 1].gate).toBe(false);
    await deleteOriCascade(db, ori.id);
  });

  test("two oris hosting the SAME port each validate their own token", async () => {
    const k = await seedUserKey(db);
    const a = await create(k.secret);
    const b = await create(k.secret);
    await waitForState(a.id, "ready");
    await waitForState(b.id, "ready");
    const ra = await (await register(a.id, { port: 3000 }, k.secret)).json();
    const rb = await (await register(b.id, { port: 3000 }, k.secret)).json();
    expect(ra.hostname).not.toBe(rb.hostname);

    // Each hostname must resolve to ITS OWN row: looked up by port alone, one of these
    // answers 404/403 with a perfectly valid token.
    for (const r of [ra, rb]) {
      expect((await app.request(`/internal/edge/ask?domain=${r.hostname}`)).status).toBe(200);
      const ok = await app.request("/internal/edge/validate", {
        headers: { "x-forwarded-host": r.hostname, "x-forwarded-uri": `/?_token=${r.token}` },
      });
      expect(ok.status).toBe(200);
    }
    // ...and one ori's token must not open the other's URL.
    const crossed = await app.request("/internal/edge/validate", {
      headers: { "x-forwarded-host": ra.hostname, "x-forwarded-uri": `/?_token=${rb.token}` },
    });
    expect(crossed.status).toBe(403);
    await deleteOriCascade(db, a.id);
    await deleteOriCascade(db, b.id);
  });

  test("flipping a route public drops its token, flipping it back mints a stored one", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const priv = await (await register(ori.id, { port: 7100 }, k.secret)).json();
    const pub = await (await register(ori.id, { port: 7100, public: true }, k.secret)).json();
    expect(pub.token).toBeNull();

    const again = await (await register(ori.id, { port: 7100 }, k.secret)).json();
    expect(again.token).toBeTruthy();
    expect(again.token).not.toBe(priv.token);
    // The token it handed out is the one the gate compares against — i.e. it was persisted.
    const valOk = await app.request("/internal/edge/validate", {
      headers: { "x-forwarded-host": again.hostname, "x-forwarded-uri": `/?_token=${again.token}` },
    });
    expect(valOk.status).toBe(200);
    await deleteOriCascade(db, ori.id);
  });

  test("list and delete routes", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await register(ori.id, { port: 4000 }, k.secret);
    await register(ori.id, { port: 4001 }, k.secret);
    const list = await (await app.request(`${ORIS}/${ori.id}/routes`, { headers: { authorization: `Bearer ${k.secret}` } })).json();
    expect(list.routes).toHaveLength(2);
    const del = await app.request(`${ORIS}/${ori.id}/routes/4000`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${k.secret}` },
    });
    expect(del.status).toBe(200);
    const list2 = await (await app.request(`${ORIS}/${ori.id}/routes`, { headers: { authorization: `Bearer ${k.secret}` } })).json();
    expect(list2.routes).toHaveLength(1);
    expect(registrar.removed).toContain(`or${ori.id.replace("or_", "")}-4000.${EDGE}`);
    await deleteOriCascade(db, ori.id);
  });

  test("50-route cap: the 51st port is refused", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    for (let p = 5000; p < 5050; p++) {
      const r = await register(ori.id, { port: p }, k.secret);
      expect(r.status).toBe(200);
    }
    const res = await register(ori.id, { port: 5050 }, k.secret);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("limit_reached");
    await deleteOriCascade(db, ori.id);
  });

  test("internal machine-token channel registers the same way", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const mt = machineToken(ori.id);
    const res = await app.request(`/internal/oris/${ori.id}/routes`, {
      method: "POST",
      headers: { authorization: `Bearer ${mt}`, "content-type": "application/json" },
      body: JSON.stringify({ port: 7000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain(`-7000.${EDGE}`);
    // A different ori's token is refused.
    const other = await create(k.secret);
    await waitForState(other.id, "ready");
    const bad = await app.request(`/internal/oris/${other.id}/routes`, {
      method: "POST",
      headers: { authorization: `Bearer ${mt}`, "content-type": "application/json" },
      body: JSON.stringify({ port: 7001 }),
    });
    expect(bad.status).toBe(404);
    await deleteOriCascade(db, ori.id);
    await deleteOriCascade(db, other.id);
  });

  test("edge ask answers existence; edge validate gates _token", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const body = await (await register(ori.id, { port: 9000 }, k.secret)).json();
    const hostname = body.hostname;

    const askOk = await app.request(`/internal/edge/ask?domain=${hostname}`);
    expect(askOk.status).toBe(200);
    const askNo = await app.request("/internal/edge/ask?domain=nope-123.on.ori.dev");
    expect(askNo.status).toBe(404);

    const valOk = await app.request(`/internal/edge/validate?whatever=1`, {
      headers: { "x-forwarded-host": hostname, "x-forwarded-uri": `/?_token=${body.token}` },
    });
    expect(valOk.status).toBe(200);
    const valBad = await app.request(`/internal/edge/validate`, {
      headers: { "x-forwarded-host": hostname, "x-forwarded-uri": "/?_token=wrong" },
    });
    expect(valBad.status).toBe(403);
    const valNone = await app.request(`/internal/edge/validate`, {
      headers: { "x-forwarded-host": hostname, "x-forwarded-uri": "/" },
    });
    expect(valNone.status).toBe(403);
    await deleteOriCascade(db, ori.id);
  });

  test("stop tears the edge routes down; resume re-registers them (same URL/token)", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const body = await (await register(ori.id, { port: 5005 }, k.secret)).json();
    const url = body.url;
    const token = body.token;

    await insertSnapshot(ori.id);
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");
    expect(registrar.removed).toContain(body.hostname);
    const rowsAfterStop = await db.select().from(portRoutes).where(eq(portRoutes.oriId, ori.id));
    expect(rowsAfterStop).toHaveLength(1); // rows survive; only the edge entry is gone

    registrar.removed = [];
    await resume(ori.id, k.secret);
    await waitForState(ori.id, "ready");
    expect(registrar.added.some((a) => a.hostname === body.hostname)).toBe(true);
    const again = await (await register(ori.id, { port: 5005 }, k.secret)).json();
    expect(again.url).toBe(url);
    expect(again.token).toBe(token);
    await deleteOriCascade(db, ori.id);
  });
});
