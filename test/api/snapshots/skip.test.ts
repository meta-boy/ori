import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildDeps, seedUserKey, type AppDeps } from "../helpers";
import { oriEvents, oris, snapshots } from "@ori/api/db/schema";
import { oriId } from "@ori/contract";
import { agentToken, machineToken } from "@ori/api/tokens";
import { takeSnapshot } from "@ori/api/snapshots/take";

/**
 * The control-plane half of change detection: when the guest answers a /snapshot
 * call with `type: "snapshot.skipped"`, takeSnapshot must NOT register anything —
 * no snapshots row, no event, no ori field update — and must report the skip as
 * its own outcome rather than a snapshot or a failure.
 *
 * The guest is faked with a tiny loopback server answering the one payload that
 * matters, so the test needs only the STS mint (minio) — no restic — and is
 * skipped when minio is down.
 */
const deps: AppDeps = buildDeps();
const db = deps.db;

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";

async function minioAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${S3_ENDPOINT.replace(/\/+$/, "")}/minio/health/live`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await minioAvailable();

let user: Awaited<ReturnType<typeof seedUserKey>>;
const created: string[] = [];

async function seedOri(ip: string): Promise<string> {
  const id = oriId();
  const mt = machineToken(id);
  const at = agentToken(id);
  await db.insert(oris).values({
    id,
    userId: user.userId,
    name: `skip ori ${id}`,
    state: "ready",
    type: "default",
    ip,
    machineTokenHash: mt,
    agentTokenHash: at,
    ttlSeconds: 3600,
  });
  deps.tokens.set(id, { machineToken: mt, agentToken: at });
  created.push(id);
  return id;
}

beforeAll(async () => {
  user = await seedUserKey(db);
});

afterAll(async () => {
  for (const id of created.splice(0)) {
    await db.delete(oriEvents).where(eq(oriEvents.oriId, id));
    await db.delete(snapshots).where(eq(snapshots.oriId, id));
    await db.delete(oris).where(eq(oris.id, id));
    deps.tokens.delete(id);
  }
});

describe.skipIf(!up)("takeSnapshot threads a guest skip", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/snapshot") {
          return Response.json({
            ok: true,
            type: "snapshot.skipped",
            mode: "auto",
            reason: "no changes since the last successful snapshot",
            createdAt: new Date().toISOString(),
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server?.stop();
  });

  test('a skip is reported as status:"skipped" and creates no rows or events', async () => {
    const ori = await seedOri(`127.0.0.1:${server.port}`);
    const at = new Date();
    const outcome = await takeSnapshot(deps, ori, "auto", at);

    // Explicit third state: not "created" (no snapshot was made) and not "failed"
    // (nothing went wrong) — the discriminator must name the skip.
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") return;
    expect(typeof outcome.reason).toBe("string");
    expect(outcome.reason.length).toBeGreaterThan(0);

    expect(await db.select().from(snapshots).where(eq(snapshots.oriId, ori))).toHaveLength(0);
    expect(await db.select().from(oriEvents).where(eq(oriEvents.oriId, ori))).toHaveLength(0);

    // A skip is not a FAILURE (no zero-rating: lastSnapshotStatus stays untouched), but it
    // IS an attempt: it advances the cadence clock and the skip-streak, which is what lets
    // the reaper back an idle sandbox's probe cadence off. snapshotAvailable stays false.
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori) });
    expect(row?.lastSnapshotAttemptAt?.getTime()).toBeGreaterThanOrEqual(at.getTime() - 1000);
    expect(row?.lastSnapshotStatus).toBeNull();
    expect(row?.snapshotAvailable).toBe(false);
    expect(row?.snapshotSkipStreak).toBe(1);
  });

  test('a skip does not advance the cadence clock when the last snapshot failed', async () => {
    // the zero-rating window keys on lastSnapshotAttemptAt while
    // lastSnapshotStatus === "failed". If a skip advanced that clock, a failure followed
    // by skips would extend the window forever and the sandbox would never be billed.
    const ori = await seedOri(`127.0.0.1:${server.port}`);
    const failedAt = new Date(Date.now() - 60_000);
    await db
      .update(oris)
      .set({ lastSnapshotStatus: "failed", lastSnapshotAttemptAt: failedAt })
      .where(eq(oris.id, ori));

    const outcome = await takeSnapshot(deps, ori, "auto", new Date());
    expect(outcome.status).toBe("skipped");

    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori) });
    // Clock anchored at the failure and streak left alone: a failing sandbox is retried at
    // the base 60s cadence — backoff must not compound with a broken backup.
    expect(row?.lastSnapshotAttemptAt?.getTime()).toBe(failedAt.getTime());
    expect(row?.lastSnapshotStatus).toBe("failed");
    expect(row?.snapshotSkipStreak).toBe(0);
  });
});
