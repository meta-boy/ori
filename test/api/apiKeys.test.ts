import { describe, expect, test, beforeAll } from "bun:test";
import { buildApp, makeDb, seedUserKey } from "./helpers";
import { assertValidResponse } from "../contract/harness";
import { apiKeys } from "@ori/api/db/schema";
import { eq } from "drizzle-orm";
import { sha256Hex } from "@ori/api/middleware/auth";

const deps = { db: makeDb() };
const app = buildApp(deps);
let key: Awaited<ReturnType<typeof seedUserKey>>;

beforeAll(async () => {
  key = await seedUserKey(deps.db);
});

interface KeysBody {
  ok: boolean;
  type: string;
  apiKeys: { id: string; name: string; keyPrefix: string; keyLastFour: string; hash?: unknown }[];
}

describe("T-P2-04 GET /api-keys", () => {
  test("returns key metadata only (never the secret)", async () => {
    const res = await app.request("/api/ori/v1/api-keys", {
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as KeysBody;
    assertValidResponse("apiKeys", body);
    expect(body.type).toBe("api_key.list");
    expect(Array.isArray(body.apiKeys)).toBe(true);
    const mine = body.apiKeys.find((k) => k.id === key.keyId);
    expect(mine).toBeDefined();
    expect(mine!.name).toBe(key.name);
    expect(mine!.keyPrefix).toBe("ori_live");
    expect(mine!.keyLastFour).toBe(key.secret.slice(-4));
    // metadata only: no hash, no raw secret
    expect(mine!.hash).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(key.secret.slice(10));
  });

  test("excludes another user's keys and revoked keys", async () => {
    const other = await seedUserKey(deps.db);
    const revoked = await seedUserKey(deps.db, { revoked: true });
    const res = await app.request("/api/ori/v1/api-keys", {
      headers: { authorization: `Bearer ${key.secret}` },
    });
    const body = (await res.json()) as KeysBody;
    const ids = body.apiKeys.map((k) => k.id);
    expect(ids).toContain(key.keyId);
    expect(ids).not.toContain(other.keyId);
    expect(ids).not.toContain(revoked.keyId);
  });

  test("stores only the sha256 hash, never the plaintext", async () => {
    const stored = await deps.db.query.apiKeys.findFirst({ where: eq(apiKeys.id, key.keyId) });
    expect(stored!.hash).toBe(sha256Hex(key.secret));
  });
});