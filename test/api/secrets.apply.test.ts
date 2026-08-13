import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore, deleteOriCascade } from "./helpers";
import { oris, snapshots, accountSecrets } from "@ori/api/db/schema";
import { oriId, snapshotId, type Ori } from "@ori/contract";

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

async function create(body: unknown = {}, secret = key.secret): Promise<Ori> {
  const res = await app.request(ORIS, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
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
  throw new Error(`ori ${id} never reached ${state}; last=${(await db.query.oris.findFirst({ where: eq(oris.id, id) }))?.state}`);
}

async function stop(id: string, secret = key.secret) {
  const res = await app.request(`${ORIS}/${id}/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
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

async function insertSnapshot(oriIdParam: string) {
  await db.insert(snapshots).values({
    id: snapshotId(),
    oriId: oriIdParam,
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

async function seedAccountSecrets(userId: string, envContents: string, secretFiles: { path: string; contents: string }[]) {
  await db.insert(accountSecrets).values({ userId, envContents, secretFiles }).onConflictDoUpdate({
    target: accountSecrets.userId,
    set: { envContents, secretFiles },
  });
}

async function guestOf(oriIdParam: string) {
  const row = await db.query.oris.findFirst({ where: eq(oris.id, oriIdParam) });
  return driver.guest(row!.machineId!)!;
}

beforeAll(async () => {
  key = await seedUserKey(db);
});

afterAll(async () => {
  await driver.stopAll();
  await db.delete(accountSecrets).where(eq(accountSecrets.userId, key.userId));
});

describe("T-P12-01 account secrets + per-box env reach the machine", () => {
  test("account env vars + secret files are applied before the ori is ready", async () => {
    const k = await freshKey();
    await seedAccountSecrets(k.userId, "OPENAI_API_KEY=sk-test\nDATABASE_URL=postgres://db\n", [
      { path: "notes/.env", contents: "SECRET=1\n" },
    ]);
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    const guest = await guestOf(ori.id);
    expect(guest.envVars.get("OPENAI_API_KEY")).toBe("sk-test");
    expect(guest.envVars.get("DATABASE_URL")).toBe("postgres://db");
    expect(guest.secretFiles.get("notes/.env")).toBe("SECRET=1\n");
    await deleteOriCascade(db, ori.id);
  });

  test("per-box env overrides an account var with the same name", async () => {
    const k = await freshKey();
    await seedAccountSecrets(k.userId, "DATABASE_URL=account-value\nOTHER=1\n", []);
    const ori = await create({ env: { DATABASE_URL: "per-box-value" } }, k.secret);
    await waitForState(ori.id, "ready");
    const guest = await guestOf(ori.id);
    expect(guest.envVars.get("DATABASE_URL")).toBe("per-box-value");
    expect(guest.envVars.get("OTHER")).toBe("1");
    await deleteOriCascade(db, ori.id);
  });

  test("noEnv ori receives no account secrets but keeps explicitly-passed env", async () => {
    const k = await freshKey();
    await seedAccountSecrets(k.userId, "OPENAI_API_KEY=sk-secret\n", [{ path: "creds.json", contents: "{}" }]);
    const ori = await create({ env: { TENANT_ID: "acme" }, noEnv: true }, k.secret);
    await waitForState(ori.id, "ready");
    const guest = await guestOf(ori.id);
    expect(guest.envVars.has("OPENAI_API_KEY")).toBe(false);
    expect(guest.secretFiles.has("creds.json")).toBe(false);
    expect(guest.envVars.get("TENANT_ID")).toBe("acme");
    await deleteOriCascade(db, ori.id);
  });

  test("resume re-applies the effective env to the restored machine", async () => {
    const k = await freshKey();
    await seedAccountSecrets(k.userId, "PERSIST=yes\n", []);
    const ori = await create({ env: { PER_BOX: "kept" } }, k.secret);
    await waitForState(ori.id, "ready");
    await insertSnapshot(ori.id);
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");

    const res = await resume(ori.id, {}, k.secret);
    expect(res.status).toBe(202);
    await waitForState(ori.id, "ready");
    const guest = await guestOf(ori.id);
    expect(guest.envVars.get("PERSIST")).toBe("yes");
    expect(guest.envVars.get("PER_BOX")).toBe("kept");
    await deleteOriCascade(db, ori.id);
  });
});

describe("T-P12-02 POST /secrets pushes to live oris", () => {
  test("pushed.updated counts every reachable live ori and the guest receives the values", async () => {
    const k = await freshKey();
    await seedAccountSecrets(k.userId, "OLD=1\n", []);
    const a = await create({}, k.secret);
    const b = await create({}, k.secret);
    await waitForState(a.id, "ready");
    await waitForState(b.id, "ready");

    const res = await app.request("/api/ori/v1/secrets", {
      method: "POST",
      headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ envContents: "NEW=2\n", secretFiles: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pushed).toEqual({ updated: 2, failed: 0 });
    expect((await guestOf(a.id)).envVars.get("NEW")).toBe("2");
    expect((await guestOf(b.id)).envVars.get("NEW")).toBe("2");

    await deleteOriCascade(db, a.id);
    await deleteOriCascade(db, b.id);
  });

  test("stopped oris are not pushed now but pick up the values on resume", async () => {
    const k = await freshKey();
    await seedAccountSecrets(k.userId, "", []);
    const ori = await create({}, k.secret);
    await waitForState(ori.id, "ready");
    await insertSnapshot(ori.id);
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");

    const res = await app.request("/api/ori/v1/secrets", {
      method: "POST",
      headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ envContents: "LATE=1\n", secretFiles: [] }),
    });
    const body = await res.json();
    expect(body.pushed).toEqual({ updated: 0, failed: 0 });

    await resume(ori.id, {}, k.secret);
    await waitForState(ori.id, "ready");
    expect((await guestOf(ori.id)).envVars.get("LATE")).toBe("1");
    await deleteOriCascade(db, ori.id);
  });
});
