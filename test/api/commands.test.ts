import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore } from "./helpers";
import { assertValidResponse, assertErrorEnvelope } from "../contract/harness";
import { oriEnv, oris, oriEvents, snapshots, startsLog, usageLedger } from "@ori/api/db/schema";
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

async function command(id: string, body: unknown, secret = key.secret) {
  return app.request(`${ORIS}/${id}/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function stop(id: string, secret = key.secret) {
  const res = await app.request(`${ORIS}/${id}/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(202);
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

describe("T-P4-05 POST /oris/{oriId}/commands", () => {
  test("success returns command.finished with stdout, validating", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    driver.guest(row!.machineId!)!.scriptedExec = { exitCode: 0, stdout: "hello from ori\n", stderr: "" };

    const res = await command(ori.id, { command: "echo hello" }, k.secret);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("command", body);
    expect(body.type).toBe("command.finished");
    expect(body.success).toBe(true);
    expect(body.exitCode).toBe(0);
    expect(body.signal).toBeNull();
    expect(body.stdout).toBe("hello from ori\n");
    expect(body.timedOut).toBe(false);
    expect(body.cwd).toBeDefined();
    expect(body.startedAt).toBeDefined();
    expect(body.finishedAt).toBeDefined();
    await deleteOri(ori.id);
  });

  test("non-zero exit is surfaced", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    driver.guest(row!.machineId!)!.scriptedExec = { exitCode: 7, stdout: "", stderr: "boom\n" };

    const res = await command(ori.id, { command: "exit 7" }, k.secret);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("command", body);
    expect(body.success).toBe(false);
    expect(body.exitCode).toBe(7);
    expect(body.stderr).toBe("boom\n");
    await deleteOri(ori.id);
  });

  test("a cwd escape surfaces as 400 invalid_json", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");

    const res = await command(ori.id, { command: "pwd", cwd: "../etc" }, k.secret);
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("invalid_json");
    await deleteOri(ori.id);
  });

  test("timeoutSeconds 9999 is rejected as 400 invalid_json, not clamped", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");

    const res = await command(ori.id, { command: "sleep 1", timeoutSeconds: 9999 }, k.secret);
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("invalid_json");
    await deleteOri(ori.id);
  });

  test("400 machine_not_running for an archived ori", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");

    const res = await command(ori.id, { command: "echo hi" }, k.secret);
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("machine_not_running");
    await deleteOri(ori.id);
  });

  test("404 for a nonexistent ori", async () => {
    const k = await freshKey();
    const res = await command("or_99999999", { command: "echo hi" }, k.secret);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  test("404 for another user's ori (same shape as nonexistent)", async () => {
    const u1 = await freshKey();
    const u2 = await freshKey();
    const ori = await create(u2.secret);
    await waitForState(ori.id, "ready");

    const res = await command(ori.id, { command: "echo hi" }, u1.secret);
    expect(res.status).toBe(404);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("not_found");
    await deleteOri(ori.id);
  });

  test("gateway_error when the agent is unreachable, not a stack trace", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    await driver.destroy(row!.machineId!); // kill the in-process guest

    const res = await command(ori.id, { command: "echo hi" }, k.secret);
    expect(res.status).toBe(502);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("gateway_error");
    await deleteOri(ori.id);
  });

  test("requires auth", async () => {
    const res = await app.request(
      `${ORIS}/or_99999999/commands`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "echo hi" }) },
      app,
    );
    expect(res.status).toBe(401);
  });
});
