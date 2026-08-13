import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { buildApp, buildDeps, makeDb, seedUserKey, type SeededKey } from "./helpers";
import { oris, oriEnv, oriEvents, snapshots, startsLog, usageLedger } from "@ori/api/db/schema";
import { eq } from "drizzle-orm";

// Paging must be LOSSLESS. The per-endpoint tests proved that paging "works" --
// that a cursor returns a further page -- which is a weaker claim and passed while
// exactly one row per page boundary was being dropped: paginate() set nextCursor to
// the probe row (rows[limit], the first row of the NEXT page) and every call site
// then filtered strictly past it, excluding that row entirely.
//
// This asserts the property that actually matters: the union of all pages equals
// the full set, with no duplicates and no omissions, at every limit.
const deps = buildDeps();
const db = deps.db;
const app = buildApp(deps);

let key: SeededKey;
const created: string[] = [];

async function createOri(): Promise<string> {
  const res = await app.request("/api/ori/v1/oris", {
    method: "POST",
    headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
    body: JSON.stringify({ ttlSeconds: 3600 }),
  });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { ori: { id: string } };
  created.push(body.ori.id);
  return body.ori.id;
}

/** Walk every page, following nextCursor until it runs out. Returns ids in order. */
async function pageThrough(limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  // Bound the walk so a cursor that fails to advance fails loudly instead of hanging.
  for (let guard = 0; guard <= created.length + 2; guard++) {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor) qs.set("cursor", cursor);
    const res = await app.request(`/api/ori/v1/oris?${qs}`, {
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      oris: { id: string }[];
      pageInfo: { nextCursor: string | null; hasMore: boolean; limit: number };
    };
    seen.push(...body.oris.map((b) => b.id));
    if (!body.pageInfo.hasMore) return seen;
    expect(body.pageInfo.nextCursor).not.toBeNull();
    cursor = body.pageInfo.nextCursor;
  }
  throw new Error("cursor never terminated");
}

beforeAll(async () => {
  key = await seedUserKey(db);
  for (let i = 0; i < 7; i++) await createOri();
});

afterAll(async () => {
  for (const id of created) {
    // ori_events first: T-P3-07 emits on every transition and the FK blocks the delete.
    await db.delete(oriEvents).where(eq(oriEvents.oriId, id));
    await db.delete(snapshots).where(eq(snapshots.oriId, id));
    await db.delete(oriEnv).where(eq(oriEnv.oriId, id));
    await db.delete(usageLedger).where(eq(usageLedger.oriId, id));
    await db.delete(startsLog).where(eq(startsLog.oriId, id));
    await db.delete(oris).where(eq(oris.id, id));
  }
});

describe("GET /oris paging is lossless", () => {
  for (const limit of [1, 2, 3, 6, 7]) {
    test(`limit ${limit} returns every ori exactly once`, async () => {
      const seen = await pageThrough(limit);
      expect(new Set(seen).size).toBe(seen.length); // no duplicates
      expect(new Set(seen)).toEqual(new Set(created)); // no omissions
      expect(seen.length).toBe(created.length);
    });
  }

  test("pages are newest-first and strictly ordered across boundaries", async () => {
    const seen = await pageThrough(2);
    const oneShot = await pageThrough(100);
    expect(seen).toEqual(oneShot);
  });

  test("nextCursor is null exactly when hasMore is false", async () => {
    const res = await app.request("/api/ori/v1/oris?limit=100", {
      headers: { authorization: `Bearer ${key.secret}` },
    });
    const body = (await res.json()) as { pageInfo: { nextCursor: string | null; hasMore: boolean } };
    expect(body.pageInfo.hasMore).toBe(false);
    expect(body.pageInfo.nextCursor).toBeNull();
  });
});
