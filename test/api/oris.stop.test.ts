import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore } from "./helpers";
import { deleteOriCascade } from "./helpers";
import { assertValidResponse } from "../contract/harness";
import { oriEnv, oris, oriEvents, usageLedger } from "@ori/api/db/schema";
import type { Ori } from "@ori/contract";

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

async function stop(id: string, body: unknown = {}, secret = key.secret) {
  return app.request(`${ORIS}/${id}/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
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

describe("T-P3-04 POST /oris/{oriId}/stop", () => {
  test("ready -> archiving response, then archived; final snapshot taken before warm stop", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    const machineId = row!.machineId!;
    const guest = driver.guest(machineId)!;
    const destroyedBefore = driver.destroyedCount;

    const res = await stop(ori.id, {}, k.secret);
    expect(res.status).toBe(202);
    const body = await res.json();
    assertValidResponse("stop", body);
    expect(body.type).toBe("ori.stopping");
    expect(body.id).toBe(ori.id);
    expect(body.status).toBe("archiving");

    // snapshot was requested (mode final) before the machine was stopped
    expect(guest.snapshots).toHaveLength(1);
    expect(guest.snapshots[0].generation).toBe(1);

    await waitForState(ori.id, "archived");
    const after = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(after?.state).toBe("archived");
    // Warm stop: the container is halted in place, not destroyed. The row keeps its machineId
    // (so resume can start it) and drops its ip/desktop fields (it is not serving).
    expect(after?.machineId).toBe(machineId);
    expect(after?.ip).toBeNull();
    expect(driver.destroyedCount).toBe(destroyedBefore);
    expect(await driver.isAlive(machineId)).toBe(false); // stopped...
    expect(await driver.exists(machineId)).toBe(true); // ...but still on host disk
    await deleteOri(ori.id);
  });

  test("closes the usage ledger and invalidates the desktop token", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await db
      .update(oris)
      .set({ desktopAvailable: true, desktopToken: "secret-token", desktopExpiresAt: new Date() })
      .where(eq(oris.id, ori.id));

    await stop(ori.id, {}, k.secret);
    await waitForState(ori.id, "archived");

    const ledger = await db.select().from(usageLedger).where(eq(usageLedger.oriId, ori.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].oriId).toBe(ori.id);
    expect(ledger[0].machineSeconds).toBeGreaterThanOrEqual(0);
    expect(ledger[0].multiplier).toBe(1); // default type

    const after = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(after?.desktopAvailable).toBe(false);
    expect(after?.desktopToken).toBeNull();
    expect(after?.desktopExpiresAt).toBeNull();
    await deleteOri(ori.id);
  });

  test("force:true skips waiting on the final snapshot but still stops", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    const guest = driver.guest(row!.machineId!)!;

    const res = await stop(ori.id, { force: true }, k.secret);
    expect(res.status).toBe(202);
    await waitForState(ori.id, "archived");
    // no snapshot was requested
    expect(guest.snapshots).toHaveLength(0);
    await deleteOri(ori.id);
  });

  test("refuses the stop when the final snapshot fails and keeps the ori running", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    const guest = driver.guest(row!.machineId!)!;
    guest.failSnapshot = true;
    const destroyedBefore = driver.destroyedCount;

    const res = await stop(ori.id, {}, k.secret);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("internal_error");

    // ori stays up, not destroyed
    const after = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(after?.state).toBe("ready");
    expect(after?.machineId).not.toBeNull();
    expect(after?.lastSnapshotStatus).toBe("failed");
    expect(driver.destroyedCount).toBe(destroyedBefore);
    await deleteOri(ori.id);
  });

  test("force:true archives even when the snapshot would fail", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    driver.guest(row!.machineId!)!.failSnapshot = true;

    const res = await stop(ori.id, { force: true }, k.secret);
    expect(res.status).toBe(202);
    await waitForState(ori.id, "archived");
    await deleteOri(ori.id);
  });

  test("400 machine_not_running for an archived ori", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await stop(ori.id, {}, k.secret);
    await waitForState(ori.id, "archived");

    const res = await stop(ori.id, {}, k.secret);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("machine_not_running");
    await deleteOri(ori.id);
  });

  test("404 for an unknown or another user's ori", async () => {
    const k = await freshKey();
    const other = await freshKey();
    const ori = await create(other.secret);
    await waitForState(ori.id, "ready");

    expect((await stop("or_99999999", {}, k.secret)).status).toBe(404);
    expect((await stop(ori.id, {}, k.secret)).status).toBe(404);
    await deleteOri(ori.id);
  });

  test("requires auth", async () => {
    const res = await app.request(
      `${ORIS}/or_99999999/stop`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      app,
    );
    expect(res.status).toBe(401);
  });
});
