import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { oris } from "@ori/api/db/schema";
import { MACHINE_TABLE, REQUESTABLE_TYPES } from "@ori/contract";
import { buildApp, buildDeps, seedUserKey } from "./helpers";

/**
 * `display` decides whether a ori may open a graphical session at all.
 *
 * The desktop units inside a ori are lazy — they start on demand and cost nothing until then
 * (guest-agent/desktop.ts) — so this flag buys no memory. It exists so an automated caller
 * cannot start Xvfb, budgie and VNC on a 512MB nano by accident. The behaviour worth pinning
 * is therefore the default (off) and the refusal, not any resource claim.
 */
const deps = buildDeps();
const app = buildApp(deps);

function create(body: unknown, key: string) {
  return app.request("/api/ori/v1/oris", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("display at create", () => {
  test("defaults to off — an unasked-for desktop is never possible", async () => {
    const u = await seedUserKey(deps.db);
    const res = await create({}, u.secret);
    expect(res.status).toBe(202);
    const id = (await res.json()).ori.id;

    const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, id) });
    expect(row!.display).toBe(false);
  });

  test("display: true is persisted", async () => {
    const u = await seedUserKey(deps.db);
    const res = await create({ display: true }, u.secret);
    expect(res.status).toBe(202);
    const id = (await res.json()).ori.id;

    const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, id) });
    expect(row!.display).toBe(true);
  });

  test("POST /desktop on a display-less ori is 409 display_disabled, not a blank URL", async () => {
    const u = await seedUserKey(deps.db);
    const id = (await (await create({}, u.secret)).json()).ori.id;

    // Reach `ready` the way the desktop gate expects, so the refusal is about `display`
    // and not about the state machine.
    await deps.db.update(oris).set({ state: "ready" }).where(eq(oris.id, id));

    const res = await app.request(`/api/ori/v1/oris/${id}/desktop`, {
      method: "POST",
      headers: { authorization: `Bearer ${u.secret}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("display_disabled");
  });
});

/**
 * Every requestable type must survive the round trip through the request validator.
 *
 * This exists because it did not. `nano` was added to MACHINE_TABLE and REQUESTABLE_TYPES while
 * the zod enum in schemas.ts listed the types a second time, so the API answered 400
 * invalid_json to a type its own table documented. The whole unit suite passed: no test had
 * ever created a machine type over HTTP — they asserted the table, or inserted rows directly.
 * A real request on a real host found it in one call.
 */
describe("every requestable type is actually requestable", () => {
  for (const type of REQUESTABLE_TYPES) {
    test(`POST /oris {type: ${type}} is accepted and reports that type's spec`, async () => {
      const u = await seedUserKey(deps.db);
      const res = await create({ type }, u.secret);
      expect(res.status).toBe(202);

      const { ori } = await res.json();
      expect(ori.type).toBe(type);
      expect(ori.vcpu).toBe(MACHINE_TABLE[type].vcpu);
      expect(ori.memoryGB).toBe(MACHINE_TABLE[type].memoryGB);
    });
  }
});
