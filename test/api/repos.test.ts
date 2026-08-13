import { describe, expect, test, beforeAll } from "bun:test";
import { buildApp, makeDb, seedUserKey } from "./helpers";
import { assertValidResponse, assertErrorEnvelope } from "../contract/harness";

const deps = { db: makeDb() };
const app = buildApp(deps);
let key: Awaited<ReturnType<typeof seedUserKey>>;

const REPOS = "/api/ori/v1/repos";

beforeAll(async () => {
  key = await seedUserKey(deps.db);
});

describe("T-P2-08 GET /repos stub", () => {
  test("returns empty installations and selection, validating", async () => {
    const res = await app.request(REPOS, { headers: { authorization: `Bearer ${key.secret}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("repos", body);
    expect(body.type).toBe("repos.list");
    expect(body.installations).toEqual([]);
    expect(body.selectedRepositories).toEqual([]);
    expect(body.pageInfo).toEqual({ nextCursor: null, hasMore: false, limit: 100 });
  });

  test("ignores query params (sync/q/selected) without error", async () => {
    const res = await app.request(`${REPOS}?sync=true&q=web&selected=true`, {
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("repos", body);
  });

  test("requires auth", async () => {
    const res = await app.request(REPOS, {}, app);
    expect(res.status).toBe(401);
  });
});

describe("T-P2-08 POST /repos stub", () => {
  test("echoes a valid selection back as repos.updated", async () => {
    const res = await app.request(REPOS, {
      method: "POST",
      headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: "repo_org_123456", baseBranch: "dev" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("selectRepo", body);
    expect(body.type).toBe("repos.updated");
    expect(body.success).toBe(true);
    expect(body.selectedRepositories).toEqual([
      {
        databaseId: "repo_org_123456",
        baseBranch: "dev",
        setupRoutineId: null,
        setupScript: "",
        setupBlocking: false,
        preCommitHooks: [],
      },
    ]);
  });

  test("defaults baseBranch to main", async () => {
    const res = await app.request(REPOS, {
      method: "POST",
      headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: "repo_org_7" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("selectRepo", body);
    expect(body.selectedRepositories[0].baseBranch).toBe("main");
  });

  test("rejects a missing repositoryId with invalid_json", async () => {
    const res = await app.request(REPOS, {
      method: "POST",
      headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("invalid_json");
  });

  test("rejects invalid JSON with invalid_json", async () => {
    const res = await app.request(REPOS, {
      method: "POST",
      headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("invalid_json");
  });

  test("requires auth", async () => {
    const res = await app.request(
      REPOS,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repositoryId: "x" }) },
      app,
    );
    expect(res.status).toBe(401);
  });
});
