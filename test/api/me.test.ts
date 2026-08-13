import { describe, expect, test, beforeAll } from "bun:test";
import { buildApp, makeDb, seedUserKey } from "./helpers";
import { assertValidResponse, assertErrorEnvelope } from "../contract/harness";

const deps = { db: makeDb() };
const app = buildApp(deps);
let key: Awaited<ReturnType<typeof seedUserKey>>;

beforeAll(async () => {
  key = await seedUserKey(deps.db);
});

describe("T-P2-03 GET /me", () => {
  test("returns user.info with the authenticated identity", async () => {
    const res = await app.request("/api/ori/v1/me", {
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("me", body);
    expect(body.type).toBe("user.info");
    expect(body.user.login).toBe(key.login);
    expect(body.user.email).toBe(key.email);
  });

  test("requires auth (401 without a token)", async () => {
    const res = await app.request("/api/ori/v1/me", {}, app);
    expect(res.status).toBe(401);
    assertErrorEnvelope(await res.json());
  });
});