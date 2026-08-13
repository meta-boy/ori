import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeps, seedUserKey, deleteOriCascade, type AppDeps } from "../helpers";
import { oris, snapshots } from "@ori/api/db/schema";
import { oriId } from "@ori/contract";
import { Restic, oriRepoUrl, snapshotRepoPassword } from "@ori/api/snapshots/restic";
import { registerSnapshot } from "@ori/api/snapshots/register";
import { applyRetention } from "@ori/api/snapshots/retention";

/**
 * Retention (T-P5-12): `restic forget` then delete the corresponding snapshots
 * rows. The happy path runs against the REAL local minio and REAL restic (the
 * storage minting inside applyRetention needs a live STS, exactly as it will in
 * production), and is skipped — not failed — when either is missing.
 *
 * The other path is pure control-plane persistence: an ori that has never been
 * snapshotted must be short-circuited BEFORE any storage call, so that case runs
 * unconditionally against the real Postgres.
 */
process.env.ORI_SNAPSHOT_SECRET ??= "test-dev-secret";
// Bun auto-loads the repo's .env, which points S3_ENDPOINT_FOR_ORI at a
// container-reachable address (host.docker.internal) that a host-side test
// process cannot resolve. applyRetention mints through storageConfigFromEnv, so
// pin the ori-facing endpoint to the loopback the test can actually reach —
// otherwise restic retries the unreachable address until the timeout.
process.env.S3_ENDPOINT_FOR_ORI = process.env.S3_ENDPOINT ?? "http://localhost:9000";

const deps: AppDeps = buildDeps();
const db = deps.db;

const S3 = {
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
  secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
  bucket: process.env.S3_BUCKET ?? "ori-snapshots",
};
const BIN = process.env.RESTIC_BIN ?? "restic";
/** Snapshot repo password derives from the SAME secret applyRetention's minting reads. */
const SERVER_SECRET = process.env.ORI_SNAPSHOT_SECRET ?? "test-dev-secret";

async function resticAvailable(): Promise<boolean> {
  try {
    const p = Bun.spawn({ cmd: [BIN, "version"], stdout: "pipe", stderr: "pipe" });
    await new Response(p.stdout).text();
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

async function minioAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${S3.endpoint.replace(/\/+$/, "")}/minio/health/live`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const SKIP = !(await resticAvailable()) || !(await minioAvailable());

let user: Awaited<ReturnType<typeof seedUserKey>>;
const created: string[] = [];

async function seedOri(state = "ready"): Promise<string> {
  const id = oriId();
  await db.insert(oris).values({
    id,
    userId: user.userId,
    name: `retention ori ${id}`,
    state,
    type: "default",
    ttlSeconds: 3600,
  });
  created.push(id);
  return id;
}

beforeAll(async () => {
  user = await seedUserKey(db);
});

afterAll(async () => {
  for (const id of created) await deleteOriCascade(db, id);
});

describe("retention: a ori with no snapshots", () => {
  test("drops nothing and never touches storage (short-circuit before minting)", async () => {
    const id = await seedOri();
    const out = await applyRetention(deps, id);
    expect(out).toEqual({ removedFromRepo: [], rowsDeleted: 0, pruned: false });
    expect(await db.select().from(snapshots).where(eq(snapshots.oriId, id))).toHaveLength(0);
  });
});

/** Real restic backups + STS mints need a real-I/O budget, like the other minio tests. */
const REAL_IO_TIMEOUT_MS = 60_000;

describe.skipIf(SKIP)("retention against a real repo", () => {
  const repoPrefix = `ret-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ori = oriId();

  let srcDir: string;

  beforeAll(async () => {
    // Seed THE ori under test (its id is fixed above and shared by the repo URL,
    // the rows and applyRetention) — registerSnapshot requires the row to exist.
    await db.insert(oris).values({
      id: ori,
      userId: user.userId,
      name: `retention ori ${ori}`,
      state: "ready",
      type: "default",
      ttlSeconds: 3600,
    });
    created.push(ori);
    srcDir = await mkdtemp(join(tmpdir(), "ori-ret-src-"));
    await mkdir(join(srcDir, "dir"), { recursive: true });
    await writeFile(join(srcDir, "file.txt"), "retention payload\n");
    await writeFile(join(srcDir, "dir", "blob.bin"), Buffer.from([0x00, 0x01, 0xfe, 0xff]));

    // Three real backups, each registered exactly as a guest /snapshot result would be.
    const restic = new Restic({
      bin: BIN,
      repo: oriRepoUrl(S3.endpoint, S3.bucket, ori),
      password: snapshotRepoPassword(ori, SERVER_SECRET),
      s3: S3,
    });
    try {
      await restic.init();
      for (let i = 0; i < 3; i++) {
        const r = await restic.backup([srcDir], { tags: [`ori=${ori}`] });
        const out = await registerSnapshot(deps, ori, {
          ok: true,
          type: "snapshot.created",
          mode: "auto",
          snapshotId: r.snapshotId,
          sizeBytes: r.summary.totalBytesProcessed,
          fileCount: r.summary.totalFilesProcessed,
          contentSizeBytes: r.summary.totalBytesProcessed,
          contentFileCount: r.summary.totalFilesProcessed,
          chunks: [],
        });
        expect(out.ok).toBe(true);
      }
    } finally {
      await restic.close();
    }
  }, REAL_IO_TIMEOUT_MS);

  test("forget --keep-last 1 drops the oldest two snapshots AND their rows", async () => {
    expect(await db.select().from(snapshots).where(eq(snapshots.oriId, ori))).toHaveLength(3);

    const out = await applyRetention(deps, ori, { policy: { keepLast: 1 } });
    expect(out.removedFromRepo).toHaveLength(2);
    expect(out.rowsDeleted).toBe(2);

    const repo = new Restic({
      bin: BIN,
      repo: oriRepoUrl(S3.endpoint, S3.bucket, ori),
      password: snapshotRepoPassword(ori, SERVER_SECRET),
      s3: S3,
    });
    try {
      const snaps = await repo.snapshots();
      expect(snaps).toHaveLength(1);
    } finally {
      await repo.close();
    }
    expect(await db.select().from(snapshots).where(eq(snapshots.oriId, ori))).toHaveLength(1);
  }, REAL_IO_TIMEOUT_MS);

  test("the default policy (keep-last 50 + keep-daily 7) drops nothing on a small repo", async () => {
    // The policy is restic's union: keep the newest 50 AND one per day for a week.
    // A single surviving snapshot satisfies both, so this asserts the default flows
    // through forget as a combined flag set without removing anything it should not.
    const out = await applyRetention(deps, ori);
    expect(out.removedFromRepo).toEqual([]);
    expect(out.rowsDeleted).toBe(0);
    expect(await db.select().from(snapshots).where(eq(snapshots.oriId, ori))).toHaveLength(1);
  }, REAL_IO_TIMEOUT_MS);
});
