import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore, deleteOriCascade } from "./helpers";
import { oris, oriEvents, promptRuns } from "@ori/api/db/schema";
import type { Ori } from "@ori/contract";

/**
 * T-P12-04/05 — the agent layer: queue a prompt, watch the ori flip to running, see the
 * guest's lines arrive as response events, and finish back at idle. Runs against the fake
 * guest, whose prompt simulation is scripted by the test (push lines, flip done).
 */

const db = makeDb();
const driver = new FakeMachineDriver();
const tokens = new TokenStore();
const deps = { db, driver, tokens };
const app = buildApp(deps);

let key: Awaited<ReturnType<typeof seedUserKey>>;
const ORIS = "/api/ori/v1/oris";

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

async function waitFor(fn: () => Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await Bun.sleep(30);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function guestOf(oriId: string) {
  const row = await db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  return driver.guest(row!.machineId!)!;
}

async function prompt(oriId: string, body: unknown, secret = key.secret) {
  return app.request(`${ORIS}/${oriId}/prompt`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function interrupt(oriId: string, secret = key.secret) {
  return app.request(`${ORIS}/${oriId}/interrupt`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
  });
}

beforeAll(async () => {
  key = await seedUserKey(db);
});

afterAll(async () => {
  await driver.stopAll();
});

describe("T-P12-05 agent prompt flow", () => {
  test("queue a prompt: ori -> running, response events stream, run finishes -> idle", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");

    const res = await prompt(ori.id, { provider: "codex", model: "gpt-5.4", reasoningEffort: "medium", prompt: "Run the tests" }, k.secret);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.type).toBe("prompt.queued");
    expect(body.promptRun.status).toBe("queued");
    expect(body.promptId).toBeTruthy();
    const runId = body.promptId;

    await waitForState(ori.id, "running");
    const guest = await guestOf(ori.id);
    expect(guest.lastPrompt?.prompt).toBe("Run the tests");
    expect(guest.lastPrompt?.provider).toBe("codex");

    // Script some agent output, then finish.
    guest.promptRuns.get(runId)!.lines.push({ stream: "stdout", text: "starting..." });
    guest.promptRuns.get(runId)!.lines.push({ stream: "stdout", text: "all tests pass" });
    guest.promptRuns.get(runId)!.done = true;
    guest.promptRuns.get(runId)!.status = "finished";

    await waitFor(async () => {
      const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
      return row?.state === "idle";
    }, "ori back to idle");

    const run = await db.query.promptRuns.findFirst({ where: eq(promptRuns.id, runId) });
    expect(run?.done).toBe(true);
    expect(run?.status).toBe("finished");

    // Events: prompt.queued, response lines, prompt.finished — taskId pins them to the run.
    const events = await db.select().from(oriEvents).where(eq(oriEvents.oriId, ori.id)).orderBy((t) => t.seq);
    const types = events.map((e) => e.type);
    expect(types).toContain("prompt");
    expect(types).toContain("response");
    const responses = events.filter((e) => e.type === "response" && e.taskId === runId);
    expect(responses.length).toBe(2);
    expect(responses[0]!.data!.content).toContain("starting");
    const terminal = events.filter((e) => e.type === "prompt" && (e.data as any)?.status === "finished");
    expect(terminal.length).toBe(1);

    // Prompt-run status endpoint agrees.
    const st = await app.request(`${ORIS}/${ori.id}/prompts/${runId}`, { headers: { authorization: `Bearer ${k.secret}` } });
    expect(st.status).toBe(200);
    const stBody = await st.json();
    expect(stBody.promptRun.done).toBe(true);
    expect(stBody.promptRun.status).toBe("finished");

    await deleteOriCascade(db, ori.id);
  });

  test("a second prompt while one is active is refused with ori_not_promptable", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const r1 = await prompt(ori.id, { provider: "codex", prompt: "first" }, k.secret);
    expect(r1.status).toBe(202);
    await waitForState(ori.id, "running");
    const r2 = await prompt(ori.id, { provider: "codex", prompt: "second" }, k.secret);
    expect(r2.status).toBe(409);
    expect((await r2.json()).code).toBe("ori_not_promptable");
    // finish the first so teardown is clean
    const guest = await guestOf(ori.id);
    const runId = (await r1.json()).promptId;
    guest.promptRuns.get(runId)!.done = true;
    guest.promptRuns.get(runId)!.status = "finished";
    await waitFor(async () => (await db.query.oris.findFirst({ where: eq(oris.id, ori.id) }))?.state === "idle", "idle");
    await deleteOriCascade(db, ori.id);
  });

  test("interrupt marks the run done and the ori idle", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const r = await prompt(ori.id, { provider: "claude-code", prompt: "long task" }, k.secret);
    expect(r.status).toBe(202);
    const runId = (await r.json()).promptId;
    await waitForState(ori.id, "running");

    const ir = await interrupt(ori.id, k.secret);
    expect(ir.status).toBe(200);
    await waitForState(ori.id, "idle");
    const run = await db.query.promptRuns.findFirst({ where: eq(promptRuns.id, runId) });
    expect(run?.done).toBe(true);
    expect(run?.status).toBe("interrupted");
    expect((await guestOf(ori.id)).interruptCalls).toBe(1);
    await deleteOriCascade(db, ori.id);
  });

  test("prompt on a stopped ori is refused (state gate)", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await app.request(`${ORIS}/${ori.id}/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    await waitForState(ori.id, "archived");
    const res = await prompt(ori.id, { provider: "codex", prompt: "hi" }, k.secret);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ori_not_promptable");
    await deleteOriCascade(db, ori.id);
  });

  test("requires auth and a non-empty prompt", async () => {
    const k = await seedUserKey(db);
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const noAuth = await app.request(`${ORIS}/${ori.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "codex", prompt: "x" }),
    });
    expect(noAuth.status).toBe(401);
    const res = await prompt(ori.id, { provider: "codex", prompt: "   " }, k.secret);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("prompt_required");
    await deleteOriCascade(db, ori.id);
  });
});
