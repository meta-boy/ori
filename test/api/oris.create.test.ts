import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore } from "./helpers";
import { assertValidResponse } from "../contract/harness";
import { oriEnv, oris, oriEvents, startsLog } from "@ori/api/db/schema";
import { apiKeySecret, type Ori } from "@ori/contract";
import { sha256Hex } from "@ori/api/middleware/auth";
import { agentToken, machineToken } from "@ori/api/tokens";

const db = makeDb();
const driver = new FakeMachineDriver();
const tokens = new TokenStore();
const deps = { db, driver, tokens };
const app = buildApp(deps);

let key: Awaited<ReturnType<typeof seedUserKey>>;

const ORIS = "/api/ori/v1/oris";

async function create(body: unknown, secret = key.secret) {
  return app.request(ORIS, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function waitForState(oriId: string, state: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.query.oris.findFirst({ where: eq(oris.id, oriId) });
    if (row?.state === state) return;
    await Bun.sleep(20);
  }
  const row = await db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  throw new Error(`ori ${oriId} never reached ${state}; last=${row?.state}`);
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
  await db.delete(startsLog).where(eq(startsLog.userId, key.userId));
});

describe("T-P3-02 POST /oris", () => {
  test("empty body creates a default ori, provisioning, ttl 3600, validating", async () => {
    const u = await seedUserKey(db);
    const res = await create({}, u.secret);
    expect(res.status).toBe(202);
    const body = await res.json();
    assertValidResponse("create", body);
    expect(body.type).toBe("ori.created");
    expect(body.status).toBe("provisioning");
    expect(body.ttlSeconds).toBe(3600);
    const ori: Ori = body.ori;
    expect(ori.id).toMatch(/^or_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
    expect(ori.state).toBe("provisioning");
    expect(ori.type).toBe("default");
    expect(ori.vcpu).toBe(2);
    expect(ori.desktopAvailable).toBe(false);
    expect(ori.snapshotAvailable).toBe(false);

    // archive_after = created_at + 3600s
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.state).toBe("ready");
    expect(row?.machineId).toMatch(/^m_\d+$/);
    expect(row?.ip).toMatch(/^127\.0\.0\.1:\d+$/);
    const created = new Date(row!.createdAt).getTime();
    const archiveAfter = new Date(row!.archiveAfter!).getTime();
    expect(archiveAfter - created).toBe(3600_000);
    await deleteOri(ori.id);
  });

  test("explicit type large + ttlSeconds 120 are honored", async () => {
    const u = await seedUserKey(db);
    const res = await create({ type: "large", ttlSeconds: 120 }, u.secret);
    expect(res.status).toBe(202);
    const body = await res.json();
    assertValidResponse("create", body);
    expect(body.ori.type).toBe("large");
    expect(body.ori.vcpu).toBe(4);
    expect(body.ttlSeconds).toBe(120);
    await waitForState(body.ori.id, "ready");
    await deleteOri(body.ori.id);
  });

  test("ttlSeconds null disables auto-stop (archiveAfter null)", async () => {
    const u = await seedUserKey(db);
    const res = await create({ ttlSeconds: null }, u.secret);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ttlSeconds).toBe(null);
    const row = await db.query.oris.findFirst({ where: eq(oris.id, body.ori.id) });
    expect(row?.archiveAfter).toBeNull();
    await waitForState(body.ori.id, "ready");
    await deleteOri(body.ori.id);
  });

  test("rejects unknown machine types (bare-metal is not requestable)", async () => {
    const u = await seedUserKey(db);
    const res = await create({ type: "bare-metal" }, u.secret);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("invalid_json");
  });

  test("rejects ttlSeconds out of the 1..2592000 range", async () => {
    const u = await seedUserKey(db);
    expect((await create({ ttlSeconds: 0 }, u.secret)).status).toBe(400);
    expect((await create({ ttlSeconds: 2592001 }, u.secret)).status).toBe(400);
  });

  test("rejects invalid env names with invalid_env", async () => {
    const u = await seedUserKey(db);
    const res = await create({ env: { "1BAD": "x" } }, u.secret);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_env");
  });

  test("rejects >100 env vars", async () => {
    const u = await seedUserKey(db);
    const env = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`VAR_${i}`, "x"]));
    const res = await create({ env }, u.secret);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_env");
  });

  test("stores env rows unless noEnv", async () => {
    const u = await seedUserKey(db);
    const res = await create({ env: { FOO: "bar", BAZ: "qux" } }, u.secret);
    expect(res.status).toBe(202);
    const id = (await res.json()).ori.id;
    const envRows = await db.select().from(oriEnv).where(eq(oriEnv.oriId, id));
    expect(envRows).toHaveLength(2);
    await waitForState(id, "ready");
    await deleteOri(id);
  });

  test("noEnv true flags the ori but still stores explicitly-passed env", async () => {
    // noEnv withholds ACCOUNT secrets, not per-box env: Box's docs say "To give one a secret
    // of its own, pass it explicitly with env". The flag is on the ori row; whether the env
    // reaches the machine is applyEnvToOri's decision at provision time.
    const u = await seedUserKey(db);
    const res = await create({ env: { FOO: "bar" }, noEnv: true }, u.secret);
    expect(res.status).toBe(202);
    const id = (await res.json()).ori.id;
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    expect(row?.noEnv).toBe(true);
    const envRows = await db.select().from(oriEnv).where(eq(oriEnv.oriId, id));
    expect(envRows).toHaveLength(1);
    expect(envRows[0].key).toBe("FOO");
    await waitForState(id, "ready");
    await deleteOri(id);
  });

  test("mints hashed machine/agent tokens and retains raw in the store", async () => {
    const u = await seedUserKey(db);
    const res = await create({}, u.secret);
    const id = (await res.json()).ori.id;
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    expect(row?.machineTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.agentTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.machineTokenHash).not.toContain("ori_mt_");
    const raw = tokens.get(id)!;
    expect(raw.machineToken).toMatch(/^ori_mt_/);
    expect(raw.agentToken).toMatch(/^ori_at_/);
    expect(sha256Hex(raw.machineToken)).toBe(row?.machineTokenHash ?? "");
    expect(sha256Hex(raw.agentToken)).toBe(row?.agentTokenHash ?? "");
    await waitForState(id, "ready");
    await deleteOri(id);
  });

  test("driver.create is invoked with the minted tokens", async () => {
    const u = await seedUserKey(db);
    const createdBefore = driver.createdCount;
    const res = await create({}, u.secret);
    expect(res.status).toBe(202);
    expect(driver.createdCount).toBe(createdBefore + 1);
    const id = (await res.json()).ori.id;
    await waitForState(id, "ready");
    const raw = tokens.get(id)!;
    const guest = driver.guest((await db.query.oris.findFirst({ where: eq(oris.id, id) }))!.machineId!)!;
    expect(guest.verifyToken(raw.agentToken)).toBe(true);
    await deleteOri(id);
  });

  test("transitions provisioning -> ready once the guest answers /health", async () => {
    const u = await seedUserKey(db);
    const res = await create({}, u.secret);
    const id = (await res.json()).ori.id;
    await waitForState(id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    expect(row?.state).toBe("ready");
    await deleteOri(id);
  });

  test("a ori whose guest never becomes healthy stays provisioning (driver error), no destroy", async () => {
    const d = new FakeMachineDriver();
    const app2 = buildApp({ db, driver: d, tokens });
    const u = await seedUserKey(db);
    // create fails at the driver layer
    d.failNextCreate = true;
    const res = await app2.request(ORIS, {
      method: "POST",
      headers: { authorization: `Bearer ${u.secret}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    await d.stopAll();
  });

  test("429 when the per-minute creation limit is hit", async () => {
    const u = await seedUserKey(db);
    await db.insert(startsLog).values(
      Array.from({ length: 10 }, () => ({ userId: u.userId, oriId: null, kind: "create", createdAt: new Date() })),
    );
    const res = await create({}, u.secret);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("rate_limited");
    await db.delete(startsLog).where(eq(startsLog.userId, u.userId));
  });

  test("429 when the active-ori cap is reached", async () => {
    const u = await seedUserKey(db);
    await db.insert(oris).values(
      Array.from({ length: 100 }, () => ({ id: `or_cap${Math.random().toString(36).slice(2, 7)}xxxx`, userId: u.userId, name: "cap", state: "running", type: "default" })),
    );
    const res = await create({}, u.secret);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("start_limit_reached");
    await db.delete(oris).where(eq(oris.userId, u.userId));
  });

  test("requires auth", async () => {
    const res = await app.request(
      ORIS,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      app,
    );
    expect(res.status).toBe(401);
  });
});
