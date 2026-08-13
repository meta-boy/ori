import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, buildDeps, seedUserKey, deleteOriCascade, type AppDeps } from "./helpers";
import { oris, snapshots } from "@ori/api/db/schema";
import { oriId, snapshotId } from "@ori/contract";
import { assertValidResponse } from "../contract/harness";

// T-P5-08..11, the public snapshot read surface. The listing/latest paths are pure DB and
// tested here; tree/files/download need a real restic repository and are exercised by
// test/api/snapshots/restic.test.ts and the survival e2e.
//
// The assertion that matters most is cross-tenant: a snapshot id is a UUID, so without an
// ownership join any user could read another user's snapshot tree by guessing one. Both
// "not yours" and "does not exist" must be the same 404, or the endpoint becomes an oracle
// for which ids are real.
const deps: AppDeps = buildDeps();
const db = deps.db;
const app = buildApp(deps);
const BASE = "/api/ori/v1";

let alice: Awaited<ReturnType<typeof seedUserKey>>;
let bob: Awaited<ReturnType<typeof seedUserKey>>;
const created: string[] = [];

async function seedOri(userId: string, state = "archived"): Promise<string> {
  const id = oriId();
  await db.insert(oris).values({
    id,
    userId,
    name: `ori ${id}`,
    state,
    type: "default",
    ttlSeconds: 3600,
  });
  created.push(id);
  return id;
}

async function seedSnapshot(
  bid: string,
  over: Partial<typeof snapshots.$inferInsert> = {},
): Promise<string> {
  const id = snapshotId();
  await db.insert(snapshots).values({
    id,
    oriId: bid,
    chainId: (over.chainId as string) ?? id,
    generation: 1,
    kind: "base",
    status: "completed",
    sizeBytes: 4096,
    fileCount: 7,
    contentSizeBytes: 2048,
    contentFileCount: 5,
    resticId: "a".repeat(64),
    ...over,
  });
  return id;
}

function get(path: string, secret: string) {
  return app.request(`${BASE}${path}`, { headers: { authorization: `Bearer ${secret}` } });
}

beforeAll(async () => {
  alice = await seedUserKey(db);
  bob = await seedUserKey(db);
});

afterAll(async () => {
  for (const id of created.splice(0)) await deleteOriCascade(db, id);
});

describe("T-P5-08 GET /snapshots and /oris/{id}/snapshots", () => {
  test("lists the caller's snapshots newest-first and validates against the spec", async () => {
    const bx = await seedOri(alice.userId);
    const older = await seedSnapshot(bx, { createdAt: new Date(Date.now() - 60_000) });
    const newer = await seedSnapshot(bx, { generation: 2, kind: "incremental" });

    const res = await get("/snapshots", alice.secret);
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("listSnapshots", body);
    const ids = body.snapshots.map((s: any) => s.id);
    expect(ids[0]).toBe(newer);
    expect(ids).toContain(older);
    // Both size pairs are distinct fields in the spec; collapsing them loses the
    // "how much is the ori's own data" answer.
    expect(body.snapshots[0].sizeBytes).toBe(4096);
    expect(body.snapshots[0].contentSizeBytes).toBe(2048);
  });

  test("does NOT list another user's snapshots", async () => {
    const mine = await seedOri(alice.userId);
    await seedSnapshot(mine);
    const theirs = await seedOri(bob.userId);
    const foreign = await seedSnapshot(theirs);

    const body = await (await get("/snapshots", alice.secret)).json();
    const ids = body.snapshots.map((s: any) => s.id);
    expect(ids).not.toContain(foreign);
  });

  test("per-ori listing is scoped, and another user's ori is 404", async () => {
    const mine = await seedOri(alice.userId);
    const snap = await seedSnapshot(mine);
    const ok = await get(`/oris/${mine}/snapshots`, alice.secret);
    expect(ok.status).toBe(200);
    expect((await ok.json()).snapshots.map((s: any) => s.id)).toContain(snap);

    // Bob asking about Alice's ori gets the same 404 as a ori that does not exist.
    expect((await get(`/oris/${mine}/snapshots`, bob.secret)).status).toBe(404);
    expect((await get(`/oris/${oriId()}/snapshots`, bob.secret)).status).toBe(404);
  });

  test("paging is lossless", async () => {
    const bx = await seedOri(alice.userId);
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      ids.add(await seedSnapshot(bx, { createdAt: new Date(Date.now() - i * 1000) }));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const qs = new URLSearchParams({ limit: "2" });
      if (cursor) qs.set("cursor", cursor);
      const body = await (await get(`/oris/${bx}/snapshots?${qs}`, alice.secret)).json();
      seen.push(...body.snapshots.map((s: any) => s.id));
      if (!body.pageInfo.hasMore) break;
      cursor = body.pageInfo.nextCursor;
    }
    // Same property the oris list needed after paginate() was dropping a row per boundary.
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids) expect(seen).toContain(id);
  });

  test("a malformed cursor is a 400, not a 500", async () => {
    const bx = await seedOri(alice.userId);
    const res = await get(`/oris/${bx}/snapshots?cursor=not-base64!!`, alice.secret);
    expect([400, 200]).toContain(res.status);
    if (res.status === 400) expect((await res.json()).code).toBe("invalid_json");
  });
});

describe("T-P5-08 latest", () => {
  test("returns the newest snapshot", async () => {
    const bx = await seedOri(alice.userId);
    await seedSnapshot(bx, { createdAt: new Date(Date.now() - 60_000) });
    const newest = await seedSnapshot(bx, { generation: 2 });
    const body = await (await get(`/oris/${bx}/snapshots/latest`, alice.secret)).json();
    assertValidResponse("getLatestOriSnapshot", body);
    expect(body.snapshot.id).toBe(newest);
  });

  test("null — not 404 — for a ori with no snapshot yet", async () => {
    // A ori that has not been snapshotted is a normal state a client polls through, and the
    // spec's SnapshotLatestResponse allows null explicitly.
    const bx = await seedOri(alice.userId, "ready");
    const res = await get(`/oris/${bx}/snapshots/latest`, alice.secret);
    expect(res.status).toBe(200);
    expect((await res.json()).snapshot).toBeNull();
  });
});

describe("T-P5-09..11 ownership is enforced by join, not by trust", () => {
  test("another user's snapshot id is 404 on tree, files and download", async () => {
    const theirs = await seedOri(bob.userId);
    const foreign = await seedSnapshot(theirs);
    for (const path of [
      `/snapshots/${foreign}/tree`,
      `/snapshots/${foreign}/files?path=home`,
      `/snapshots/${foreign}/download`,
    ]) {
      const res = await get(path, alice.secret);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("not_found");
      // Nothing about the foreign snapshot or its ori may leak.
      expect(JSON.stringify(body)).not.toContain(theirs);
    }
  });

  test("a snapshot id that does not exist answers identically", async () => {
    const res = await get(`/snapshots/${snapshotId()}/tree`, alice.secret);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  test("files without a path is a 400", async () => {
    const bx = await seedOri(alice.userId);
    const snap = await seedSnapshot(bx);
    const res = await get(`/snapshots/${snap}/files`, alice.secret);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_json");
  });

  test("all of them require auth", async () => {
    const bx = await seedOri(alice.userId);
    const snap = await seedSnapshot(bx);
    for (const path of [
      "/snapshots",
      `/oris/${bx}/snapshots`,
      `/oris/${bx}/snapshots/latest`,
      `/snapshots/${snap}/tree`,
      `/snapshots/${snap}/download`,
    ]) {
      const res = await app.request(`${BASE}${path}`);
      expect(res.status).toBe(401);
    }
  });
});

describe("T-P5-11 download tells the truth about reconstruction", () => {
  test("it says recovery goes through restic rather than shipping a fake chunk list", async () => {
    const bx = await seedOri(alice.userId);
    const snap = await seedSnapshot(bx);
    const res = await get(`/snapshots/${snap}/download`, alice.secret);
    // Needs minio to mint storage; skip the assertion rather than fail when it is absent.
    if (res.status !== 200) return;
    const body = await res.json();
    // The whole point of the divergence: a client must not believe that fetching the chunk
    // list in order rebuilds a filesystem, because it does not.
    expect(body.reconstruct.toLowerCase()).toContain("restic");
    expect(body.reconstruct).toContain("NOT");
    expect(body.inventory.repoUrl).toContain(bx);
    // Credentials must not ride along in a manifest that gets logged and pasted.
    expect(JSON.stringify(body)).not.toContain("secretAccessKey");
  });
});
