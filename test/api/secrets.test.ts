import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { buildApp, makeDb, seedUserKey } from "./helpers";
import { assertValidResponse, assertErrorEnvelope } from "../contract/harness";
import { accountSecrets } from "@ori/api/db/schema";
import { eq } from "drizzle-orm";

const deps = { db: makeDb() };
const app = buildApp(deps);
let key: Awaited<ReturnType<typeof seedUserKey>>;

const SECRETS = "/api/ori/v1/secrets";

async function postSecrets(body: unknown, token: string) {
  return app.request(SECRETS, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getSecrets(token: string) {
  return app.request(SECRETS, { headers: { authorization: `Bearer ${token}` } });
}

beforeAll(async () => {
  key = await seedUserKey(deps.db);
});

afterAll(async () => {
  await deps.db.delete(accountSecrets).where(eq(accountSecrets.userId, key.userId));
});

describe("T-P2-07 GET /secrets", () => {
  test("empty account returns secrets.info with empty env and no files, validating", async () => {
    const res = await getSecrets(key.secret);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("secrets", body);
    expect(body.type).toBe("secrets.info");
    expect(body.envContents).toBe("");
    expect(body.secretFiles).toEqual([]);
    expect(body.environmentId).toMatch(/^env_[0-9a-f]{12}$/);
  });

  test("returns stored envContents and secretFiles after an update", async () => {
    await postSecrets(
      {
        envContents: "OPENAI_API_KEY=sk-test\nDATABASE_URL=postgres://db\n",
        secretFiles: [{ path: ".config/service-account.json", contents: '{"type":"service_account"}' }],
      },
      key.secret,
    );
    const res = await getSecrets(key.secret);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("secrets", body);
    expect(body.envContents).toBe("OPENAI_API_KEY=sk-test\nDATABASE_URL=postgres://db\n");
    expect(body.secretFiles).toEqual([
      { path: ".config/service-account.json", contents: '{"type":"service_account"}' },
    ]);
  });

  test("requires auth", async () => {
    const res = await app.request(SECRETS, {}, app);
    expect(res.status).toBe(401);
  });
});

describe("T-P2-07 POST /secrets", () => {
  test("stores a valid envContents + secretFiles and echoes secrets.updated", async () => {
    const res = await postSecrets(
      { envContents: "FOO=1\nBAR=2\n", secretFiles: [{ path: "creds.json", contents: "{}" }] },
      key.secret,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("updateSecrets", body);
    expect(body.type).toBe("secrets.updated");
    expect(body.success).toBe(true);
    expect(body.envContents).toBe("FOO=1\nBAR=2\n");
    expect(body.secretFiles).toEqual([{ path: "creds.json", contents: "{}" }]);
    expect(body.pushed).toEqual({ updated: 0, failed: 0 });

    const row = await deps.db.query.accountSecrets.findFirst({ where: eq(accountSecrets.userId, key.userId) });
    expect(row?.envContents).toBe("FOO=1\nBAR=2\n");
    expect(row?.secretFiles).toEqual([{ path: "creds.json", contents: "{}" }]);
  });

  test("omitted fields are treated as empty (full replacement, not a patch)", async () => {
    const res = await postSecrets({}, key.secret);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("updateSecrets", body);
    expect(body.envContents).toBe("");
    expect(body.secretFiles).toEqual([]);
  });

  test("rejects invalid env var names with invalid_env", async () => {
    const res = await postSecrets({ envContents: "1INVALID=value\n" }, key.secret);
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("invalid_env");
  });

  test("rejects >100 env vars with invalid_env", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `VAR_${i}=x`).join("\n") + "\n";
    const res = await postSecrets({ envContents: many }, key.secret);
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("invalid_env");
  });

  test("rejects env contents over 64KB with invalid_env", async () => {
    const huge = "A=" + "x".repeat(66 * 1024) + "\n";
    const res = await postSecrets({ envContents: huge }, key.secret);
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("invalid_env");
  });

  test("rejects absolute secret file paths", async () => {
    const res = await postSecrets({ secretFiles: [{ path: "/etc/passwd", contents: "x" }] }, key.secret);
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("invalid_json");
  });

  test("rejects .. escape secret file paths", async () => {
    const res = await postSecrets({ secretFiles: [{ path: "../outside.txt", contents: "x" }] }, key.secret);
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("invalid_json");
  });

  test("rejects invalid JSON with invalid_json", async () => {
    const res = await app.request(SECRETS, {
      method: "POST",
      headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("invalid_json");
  });

  test("requires auth", async () => {
    const res = await app.request(
      SECRETS,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      app,
    );
    expect(res.status).toBe(401);
  });
});
