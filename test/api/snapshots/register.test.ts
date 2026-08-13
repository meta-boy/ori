import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { buildDeps, seedUserKey } from "../helpers";
import { oris, oriEnv, oriEvents, snapshots, snapshotChunks, startsLog, usageLedger } from "@ori/api/db/schema";
import { oriId, uuidRegex } from "@ori/contract";
import { registerSnapshot, type SnapshotCreatedResult, type SnapshotRegistration } from "@ori/api/snapshots/register";

/**
 * T-P5-04 — snapshot registration. Pure control-plane persistence over the real
 * Postgres (no restic, no minio): a successful guest /snapshot result becomes one
 * `snapshots` row plus its `snapshot_chunks` rows, the ori's snapshot_* fields are
 * updated, chain/kind/generation are computed per ori, re-registration is a no-op,
 * and a failed snapshot records last_snapshot_status without claiming a snapshot
 * exists (needs that flag to tell the truth).
 */
const deps = buildDeps();
const db = deps.db;

const RESTIC_A = "a".repeat(64);
const RESTIC_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

let user: Awaited<ReturnType<typeof seedUserKey>>;
const created: string[] = [];

async function seedOri(): Promise<string> {
  const id = oriId();
  await db.insert(oris).values({
    id,
    userId: user.userId,
    name: `snapshot ori ${id}`,
    state: "ready",
    type: "default",
    ttlSeconds: 3600,
  });
  created.push(id);
  return id;
}

function successResult(
  ori: string,
  over: Partial<SnapshotCreatedResult> = {},
): SnapshotRegistration {
  return {
    ok: true,
    type: "snapshot.created",
    mode: "auto",
    snapshotId: RESTIC_A,
    sizeBytes: 1500,
    fileCount: 8,
    contentSizeBytes: 1200,
    contentFileCount: 5,
    chunks: [
      { r2Key: `${ori}/data/${SHA_C}`, sizeBytes: 512, sha256: SHA_C },
      { r2Key: `${ori}/data/${SHA_D}`, sizeBytes: 256, sha256: SHA_D },
    ],
    ...over,
  };
}

async function snapshotsFor(ori: string) {
  return db.select().from(snapshots).where(eq(snapshots.oriId, ori)).orderBy(asc(snapshots.generation));
}

async function chunksFor(snapshotId: string) {
  return db.select().from(snapshotChunks).where(eq(snapshotChunks.snapshotId, snapshotId)).orderBy(asc(snapshotChunks.chunkIndex));
}

async function oriRow(id: string) {
  return db.query.oris.findFirst({ where: eq(oris.id, id) });
}

async function deleteOri(id: string): Promise<void> {
  const snaps = await db.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.oriId, id));
  for (const s of snaps) {
    await db.delete(snapshotChunks).where(eq(snapshotChunks.snapshotId, s.id));
  }
  await db.delete(snapshots).where(eq(snapshots.oriId, id));
  await db.delete(oriEvents).where(eq(oriEvents.oriId, id));
  await db.delete(oriEnv).where(eq(oriEnv.oriId, id));
  await db.delete(usageLedger).where(eq(usageLedger.oriId, id));
  await db.delete(startsLog).where(eq(startsLog.oriId, id));
  await db.delete(oris).where(eq(oris.id, id));
}

beforeAll(async () => {
  user = await seedUserKey(db);
});

afterAll(async () => {
  for (const id of created) await deleteOri(id);
});

describe("T-P5-04 registerSnapshot", () => {
  test("the first snapshot is generation 1, kind base, with a fresh chainId", async () => {
    const ori = await seedOri();
    const out = await registerSnapshot(deps, ori, successResult(ori));
    expect(out.ok).toBe(true);
    expect(out.ok && out.snapshot.generation).toBe(1);
    expect(out.ok && out.snapshot.kind).toBe("base");
    expect(out.ok && out.snapshot.resticId).toBe(RESTIC_A);
    expect(out.ok && out.snapshot.chainId).toMatch(uuidRegex);
    expect(out.ok && out.snapshot.idempotent).toBe(false);
    expect(out.ok && out.snapshot.id).toMatch(uuidRegex);

    const rows = await snapshotsFor(ori);
    expect(rows).toHaveLength(1);
    expect(rows[0].generation).toBe(1);
    expect(rows[0].kind).toBe("base");
    expect(rows[0].status).toBe("completed");
  });

  test("contentSizeBytes/fileCount and sizeBytes/fileCount stay distinct", async () => {
    const ori = await seedOri();
    const out = await registerSnapshot(deps, ori, successResult(ori));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.snapshot.sizeBytes).toBe(1500);
    expect(out.snapshot.fileCount).toBe(8);
    expect(out.snapshot.contentSizeBytes).toBe(1200);
    expect(out.snapshot.contentFileCount).toBe(5);

    const rows = await snapshotsFor(ori);
    expect(rows[0].sizeBytes).toBe(1500);
    expect(rows[0].fileCount).toBe(8);
    expect(rows[0].contentSizeBytes).toBe(1200);
    expect(rows[0].contentFileCount).toBe(5);
    // the sysdiff-bearing totals are strictly larger than the work-dir-only pair
    expect(rows[0].sizeBytes).toBeGreaterThan(rows[0].contentSizeBytes!);
  });

  test("the second snapshot is incremental generation 2 with the same chainId", async () => {
    const ori = await seedOri();
    const first = await registerSnapshot(deps, ori, successResult(ori, { snapshotId: RESTIC_A }));
    const second = await registerSnapshot(deps, ori, successResult(ori, { snapshotId: RESTIC_B }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.snapshot.generation).toBe(2);
    expect(second.snapshot.kind).toBe("incremental");

    const rows = await snapshotsFor(ori);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.generation)).toEqual([1, 2]);
    expect(rows.map((r) => r.kind)).toEqual(["base", "incremental"]);
    expect(rows[0].chainId).toBe(rows[1].chainId);
    expect(rows[0].chainId).toBe(first.snapshot.chainId);
  });

  test("chunk rows carry keys, sizes and hashes in order", async () => {
    const ori = await seedOri();
    const out = await registerSnapshot(deps, ori, successResult(ori));
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const chunks = await chunksFor(out.snapshot.id);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1]);
    expect(chunks.map((c) => c.sha256)).toEqual([SHA_C, SHA_D]);
    expect(chunks.map((c) => c.sizeBytes)).toEqual([512, 256]);
    expect(chunks.map((c) => c.r2Key)).toEqual([`${ori}/data/${SHA_C}`, `${ori}/data/${SHA_D}`]);
    expect(out.snapshot.chunkCount).toBe(2);
  });

  test("a snapshot with no chunks is still registered", async () => {
    const ori = await seedOri();
    const out = await registerSnapshot(deps, ori, successResult(ori, { chunks: [] }));
    expect(out.ok && out.snapshot.chunkCount).toBe(0);
    if (!out.ok) return;
    expect(await chunksFor(out.snapshot.id)).toHaveLength(0);
  });

  test("re-registering the same restic id is a no-op", async () => {
    const ori = await seedOri();
    const first = await registerSnapshot(deps, ori, successResult(ori));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const again = await registerSnapshot(deps, ori, successResult(ori));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.snapshot.id).toBe(first.snapshot.id);
    expect(again.snapshot.idempotent).toBe(true);
    expect(again.snapshot.generation).toBe(1);

    expect(await snapshotsFor(ori)).toHaveLength(1);
    expect(await chunksFor(first.snapshot.id)).toHaveLength(2);

    // the chain must not have been advanced by the duplicate, so a real new
    // snapshot still lands on generation 2
    const third = await registerSnapshot(deps, ori, successResult(ori, { snapshotId: RESTIC_B }));
    expect(third.ok && third.snapshot.generation).toBe(2);
  });

  test("a successful snapshot updates the ori snapshot_* fields", async () => {
    const ori = await seedOri();
    await registerSnapshot(deps, ori, successResult(ori));

    const row = await oriRow(ori);
    expect(row?.snapshotAvailable).toBe(true);
    expect(row?.snapshotCompletedAt).not.toBeNull();
    expect(row?.lastSnapshotAttemptAt).not.toBeNull();
    expect(row?.lastSnapshotStatus).toBe("completed");
  });

  test("a failed snapshot sets last_snapshot_status without snapshot_available", async () => {
    const ori = await seedOri();
    const out = await registerSnapshot(deps, ori, {
      ok: false,
      type: "snapshot.failed",
      mode: "final",
      error: "restic backup failed",
    });
    expect(out.ok).toBe(false);

    const row = await oriRow(ori);
    expect(row?.lastSnapshotStatus).toBe("failed");
    expect(row?.lastSnapshotAttemptAt).not.toBeNull();
    expect(row?.snapshotAvailable).toBe(false);
    expect(row?.snapshotCompletedAt).toBeNull();
    // nothing was written for a failed attempt
    expect(await snapshotsFor(ori)).toHaveLength(0);
  });

  test("a failure after a success keeps the older good snapshot available", async () => {
    const ori = await seedOri();
    await registerSnapshot(deps, ori, successResult(ori));
    const before = await oriRow(ori);

    await registerSnapshot(deps, ori, { ok: false, type: "snapshot.failed", mode: "auto", error: "blip" });

    const after = await oriRow(ori);
    expect(after?.lastSnapshotStatus).toBe("failed");
    // snapshot_available and snapshot_completed_at still describe the older good one
    expect(after?.snapshotAvailable).toBe(true);
    expect(after?.snapshotCompletedAt?.getTime()).toBe(before?.snapshotCompletedAt?.getTime());
    expect(await snapshotsFor(ori)).toHaveLength(1);
  });

  test("registering for a missing ori throws", async () => {
    await expect(registerSnapshot(deps, oriId(), successResult(oriId()))).rejects.toThrow(/not found/);
  });

  test("two oris register independent chains", async () => {
    const a = await seedOri();
    const b = await seedOri();
    await registerSnapshot(deps, a, successResult(a));
    await registerSnapshot(deps, b, successResult(b, { snapshotId: RESTIC_B }));

    const rowsA = await snapshotsFor(a);
    const rowsB = await snapshotsFor(b);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].generation).toBe(1);
    expect(rowsB[0].generation).toBe(1); // both are their ori's first snapshot
    expect(rowsA[0].chainId).not.toBe(rowsB[0].chainId);
    // same restic id used on two oris must not collide
    const dupe = await db.select().from(snapshots).where(and(eq(snapshots.oriId, a), eq(snapshots.resticId, RESTIC_B)));
    expect(dupe).toHaveLength(0);
  });
});
