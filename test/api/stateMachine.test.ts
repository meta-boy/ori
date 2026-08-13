import { describe, expect, test, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import {
  ORI_STATES,
  applyAction,
  errorOf,
  type OriAction,
  type OriState,
  type ErrorCode,
  oriId,
} from "@ori/contract";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore } from "./helpers";
import { assertValidResponse, assertErrorEnvelope } from "../contract/harness";
import { oris } from "@ori/api/db/schema";
import { machineToken, agentToken } from "@ori/api/tokens";
import { sha256Hex } from "@ori/api/middleware/auth";
import { BASE_IMAGE } from "@ori/api/constants";

const db = makeDb();
const driver = new FakeMachineDriver();
const tokens = new TokenStore();
const deps = { db, driver, tokens };
const app = buildApp(deps);

const BASE = "/api/ori/v1";

// The eight real routes from packages/api/src/routes/oris.ts.
const ACTIONS = ["list", "create", "get", "patch", "stop", "resume", "fork", "events"] as const;
type Action = (typeof ACTIONS)[number];

// Only these three are lifecycle transitions pinned in packages/contract/src/transitions.ts.
const TRANSITION_ACTIONS = new Set<Action>(["stop", "resume", "fork"]);

const SUCCESS_STATUS: Record<Action, number> = {
  list: 200,
  create: 202,
  get: 200,
  patch: 200,
  stop: 202,
  resume: 202,
  fork: 202,
  events: 200,
};

const OP_ID: Record<Action, string> = {
  list: "oris",
  create: "create",
  get: "get",
  patch: "update",
  stop: "stop",
  resume: "resume",
  fork: "fork",
  events: "events",
};

interface Expected {
  allowed: boolean;
  status?: number;
  code?: string;
  to?: OriState;
}

/** Derive the expected outcome for a (state, action) pair from the contract. */
function expectedFor(action: Action, state: OriState): Expected {
  if (TRANSITION_ACTIONS.has(action)) {
    const r = applyAction(action as OriAction, state);
    if (r.ok) return { allowed: true, to: r.to };
    return { allowed: false, status: errorOf(r.code as ErrorCode).status, code: r.code };
  }
  // list/create/get/patch/events are not state-machine actions: they always
  // succeed for an owned ori regardless of its state.
  return { allowed: true };
}
function auth(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}
function jsonAuth(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

async function drive(action: Action, oriIdParam: string, secret: string): Promise<Response> {
  switch (action) {
    case "list":
      return app.request(`${BASE}/oris`, { headers: auth(secret) });
    case "create":
      return app.request(`${BASE}/oris`, { method: "POST", headers: jsonAuth(secret), body: "{}" });
    case "get":
      return app.request(`${BASE}/oris/${oriIdParam}`, { headers: auth(secret) });
    case "patch":
      return app.request(`${BASE}/oris/${oriIdParam}`, {
        method: "PATCH",
        headers: jsonAuth(secret),
        body: JSON.stringify({ name: "matrix" }),
      });
    case "stop":
      return app.request(`${BASE}/oris/${oriIdParam}/stop`, { method: "POST", headers: jsonAuth(secret), body: "{}" });
    case "resume":
      return app.request(`${BASE}/oris/${oriIdParam}/resume`, { method: "POST", headers: jsonAuth(secret), body: "{}" });
    case "fork":
      return app.request(`${BASE}/oris/${oriIdParam}/fork`, { method: "POST", headers: jsonAuth(secret), body: "{}" });
    case "events":
      return app.request(`${BASE}/oris/${oriIdParam}/events`, { headers: auth(secret) });
  }
}

/** Insert a ori row directly in the given state, with a live fake machine. */
async function seedOri(state: OriState, userId: string): Promise<string> {
  const id = oriId();
  const mt = machineToken(id);
  const at = agentToken(id);
  const created = await driver.create({
    oriId: id,
    type: "default",
    image: BASE_IMAGE,
    machineToken: mt,
    agentToken: at,
  });
  tokens.set(id, { machineToken: mt, agentToken: at });
  await db.insert(oris).values({
    id,
    userId,
    name: `matrix-${state}`,
    state,
    type: "default",
    machineId: created.machineId,
    ip: created.ip,
    machineTokenHash: sha256Hex(mt),
    agentTokenHash: sha256Hex(at),
  });
  return id;
}

async function waitForState(id: string, state: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    if (row?.state === state) return;
    await Bun.sleep(20);
  }
  const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
  throw new Error(`ori ${id} never reached ${state}; last=${row?.state}`);
}

afterAll(async () => {
  await driver.stopAll();
});

describe("T-P3-09 state-machine matrix (every (state, action) pair)", () => {
  for (const state of ORI_STATES) {
    for (const action of ACTIONS) {
      test(`(${state}, ${action})`, async () => {
        const key = await seedUserKey(db);
        const id = await seedOri(state, key.userId);
        const expected = expectedFor(action, state);

        const res = await drive(action, id, key.secret);
        const body = await res.json();

        if (expected.allowed) {
          // Allowed: 2xx, response validates against the OpenAPI schema, and the
          // ori transitions per the table.
          expect(res.status).toBe(SUCCESS_STATUS[action]);
          assertValidResponse(OP_ID[action], body);
          if (action === "stop") await waitForState(id, "archived");
          if (action === "resume") await waitForState(id, "ready");
          if (action === "fork") {
            expect(body.id).toBeDefined();
            expect(body.id).not.toBe(id); // fork creates a NEW ori
            await waitForState(body.id, "ready");
          }
        } else {
          // Disallowed: the exact documented error code/status, and the ori is
          // left untouched (the transition was refused, not silently applied).
          expect(res.status).toBe(expected.status!);
          assertErrorEnvelope(body);
          expect(body.code).toBe(expected.code!);
          const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
          expect(row?.state).toBe(state);
        }
      });
    }
  }
});

describe("T-P3-09 a state NOT in the table is rejected, not silently allowed", () => {
  test("fork from init returns not_found", async () => {
    const key = await seedUserKey(db);
    const id = await seedOri("init", key.userId);
    const res = await app.request(`${BASE}/oris/${id}/fork`, {
      method: "POST",
      headers: jsonAuth(key.secret),
      body: "{}",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("not_found");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    expect(row?.state).toBe("init");
  });

  test("stop from archived returns machine_not_running", async () => {
    const key = await seedUserKey(db);
    const id = await seedOri("archived", key.userId);
    const res = await app.request(`${BASE}/oris/${id}/stop`, {
      method: "POST",
      headers: jsonAuth(key.secret),
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("machine_not_running");
  });

  test("resume from init returns resume_failed", async () => {
    const key = await seedUserKey(db);
    const id = await seedOri("init", key.userId);
    const res = await app.request(`${BASE}/oris/${id}/resume`, {
      method: "POST",
      headers: jsonAuth(key.secret),
      body: "{}",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("resume_failed");
  });
});
