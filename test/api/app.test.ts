import { describe, expect, test, beforeAll } from "bun:test";
import { buildApp, makeDb, seedUserKey } from "./helpers";
import { assertErrorEnvelope } from "../contract/harness";

const deps = { db: makeDb() };
const app = buildApp(deps);
let key: Awaited<ReturnType<typeof seedUserKey>>;

beforeAll(async () => {
  key = await seedUserKey(deps.db);
  app.get("/boom", () => {
    throw new Error("boom");
  });
  app.post("/echo", async (c) => {
    const body = await c.req.json();
    return c.json({ ok: true, received: body });
  });
});

describe("T-P2-01 app skeleton", () => {
  test("sets an X-Request-Id header shaped req_<base32> on every response", async () => {
    const res = await app.request("/api/ori/v1/missing", {
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(res.status).toBe(404);
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(/^req_[0-9a-z]{26}$/);
  });

  test("404 (authenticated, unknown path) returns the ori.error envelope with the requestId echoed", async () => {
    const res = await app.request("/api/ori/v1/definitely-missing", {
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.ok).toBe(false);
    expect(body.type).toBe("ori.error");
    expect(body.status).toBe(404);
    expect(body.code).toBe("not_found");
    expect(body.requestId).toBe(res.headers.get("x-request-id"));
    expect(body.error.status).toBe(404);
  });

  test("unauthenticated base-path request is rejected with 401 before 404", async () => {
    const res = await app.request("/api/ori/v1/definitely-missing", {}, app);
    expect(res.status).toBe(401);
    const body = await res.json();
    assertErrorEnvelope(body);
  });

  test("unhandled handler errors return a 500 error envelope", async () => {
    const res = await app.request("/boom", {}, app);
    expect(res.status).toBe(500);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.status).toBe(500);
    expect(body.code).toBe("internal_error");
    expect(body.requestId).toBe(res.headers.get("x-request-id"));
  });

  test("invalid JSON body returns 400 invalid_json", async () => {
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.status).toBe(400);
    expect(body.code).toBe("invalid_json");
  });

  test("honors a well-formed inbound x-request-id", async () => {
    const res = await app.request("/api/ori/v1/missing", {
      headers: {
        "x-request-id": "req_0123456789abcdefghjkmnopqr",
        authorization: `Bearer ${key.secret}`,
      },
    });
    expect(res.headers.get("x-request-id")).toBe("req_0123456789abcdefghjkmnopqr");
  });

  test("valid JSON parses fine (no false 400)", async () => {
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: { a: 1 } });
  });
});