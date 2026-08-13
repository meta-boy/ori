import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { buildDeps, seedUserKey, type AppDeps } from "../helpers";
import { oris, oriEnv, oriEvents, snapshots, snapshotChunks, startsLog, usageLedger } from "@ori/api/db/schema";
import { oriId } from "@ori/contract";
import { machineToken, agentToken } from "@ori/api/tokens";
import { snapshotIntervalMs, tick } from "@ori/api/reaper";
import { stopOri } from "@ori/api/lifecycle/stop";

// T-P5-05. Three behaviours, and the third is counterintuitive enough to be worth stating:
// when a FINAL snapshot fails, the ori stays RUNNING and accrues ZERO machine-seconds
// Ori keeps such a ori alive rather than discard the customer's work,
// and does not bill for time the customer did not ask for. Destroying it would be data
// loss; billing it would be charging for our own failure.
//
// Every test drives tick()/stopOri() with an explicit `now`. Nothing sleeps.
process.env.ORI_SNAPSHOT_SECRET ??= "test-secret";

const deps: AppDeps = buildDeps();
const db = deps.db;
let user: Awaited<ReturnType<typeof seedUserKey>>;
const created: string[] = [];

/**
 * Create a real machine through the driver, then insert the ori row pointing at it. The
 * machine must be one the driver knows: the reaper's liveness step marks a ori `error`
 * when driver.isAlive() says its machine is gone, so a made-up machineId fails the test
 * for the wrong reason. The fake driver serves a real in-process guest agent on the
 * returned ip, so snapshots actually round-trip.
 */
async function seedOri(over: Partial<typeof oris.$inferInsert> = {}): Promise<string> {
  const id = oriId();
  const mt = machineToken(id);
  const at = agentToken(id);
  const machine = await deps.driver.create({
    oriId: id,
    type: "default",
    image: "ubuntu-24.04",
    machineToken: mt,
    agentToken: at,
  });
  await db.insert(oris).values({
    id,
    userId: user.userId,
    name: `ori ${id}`,
    state: "ready",
    type: "default",
    machineId: machine.machineId,
    ip: machine.ip,
    machineTokenHash: mt,
    agentTokenHash: at,
    ttlSeconds: 3600,
    ...over,
  });
  deps.tokens.set(id, { machineToken: mt, agentToken: at });
  created.push(id);
  return id;
}

/** Point a ori at a dead address so the guest call fails while the machine stays alive. */
async function breakAgent(id: string): Promise<void> {
  await db.update(oris).set({ ip: "127.0.0.1:1" }).where(eq(oris.id, id));
}

async function ledgerFor(id: string) {
  return db.select().from(usageLedger).where(eq(usageLedger.oriId, id));
}
async function oriRow(id: string) {
  return db.query.oris.findFirst({ where: eq(oris.id, id) });
}

beforeAll(async () => {
  user = await seedUserKey(db);
});

afterEach(async () => {
  for (const id of created.splice(0)) {
    await db.delete(snapshotChunks).where(eq(snapshotChunks.snapshotId, id)).catch(() => {});
    await db.delete(snapshots).where(eq(snapshots.oriId, id));
    await db.delete(oriEvents).where(eq(oriEvents.oriId, id));
    await db.delete(oriEnv).where(eq(oriEnv.oriId, id));
    await db.delete(usageLedger).where(eq(usageLedger.oriId, id));
    await db.delete(startsLog).where(eq(startsLog.oriId, id));
    await db.delete(oris).where(eq(oris.id, id));
    deps.tokens.delete(id);
  }
});

describe("T-P5-05 auto-snapshot cadence", () => {
  test("a ready ori is snapshotted once the interval has elapsed", async () => {
    const id = await seedOri({ lastSnapshotAttemptAt: new Date(Date.now() - 120_000) });
    const r = await tick(deps, new Date());
    expect(r.snapshotted + r.snapshotFailed).toBeGreaterThan(0);
    const row = await oriRow(id);
    expect(row?.lastSnapshotAttemptAt).not.toBeNull();
    // Whatever the outcome, an auto-snapshot must never take the ori down.
    expect(row?.state).toBe("ready");
  });

  test("a ori snapshotted seconds ago is skipped", async () => {
    await seedOri({ lastSnapshotAttemptAt: new Date(Date.now() - 5_000) });
    const r = await tick(deps, new Date());
    expect(r.snapshotted + r.snapshotFailed).toBe(0);
  });

  test("an archived ori is never snapshotted", async () => {
    await seedOri({ state: "archived", machineId: null, ip: null, lastSnapshotAttemptAt: null });
    const r = await tick(deps, new Date());
    expect(r.snapshotted + r.snapshotFailed).toBe(0);
  });

  test("a running ori is snapshotted too — work in progress is exactly what needs saving", async () => {
    await seedOri({ state: "running", lastSnapshotAttemptAt: new Date(Date.now() - 120_000) });
    const r = await tick(deps, new Date());
    expect(r.snapshotted + r.snapshotFailed).toBeGreaterThan(0);
  });

  test("a failed auto-snapshot is retried on the next tick", async () => {
    const id = await seedOri({ lastSnapshotAttemptAt: new Date(Date.now() - 120_000) });
    await breakAgent(id);
    await tick(deps, new Date());
    const first = (await oriRow(id))?.lastSnapshotAttemptAt;
    // Far enough ahead that the interval has elapsed again.
    await tick(deps, new Date(Date.now() + 120_000));
    const second = (await oriRow(id))?.lastSnapshotAttemptAt;
    expect(second!.getTime()).toBeGreaterThan(first!.getTime());
  });

  test("the interval doubles with every consecutive skip, capped at an hour", () => {
    // The backoff curve itself: 60s base, doubling, 60min ceiling. Pure function, so the
    // reaper behaviour tests below can trust the numbers they seed.
    expect(snapshotIntervalMs(0)).toBe(60_000);
    expect(snapshotIntervalMs(1)).toBe(120_000);
    expect(snapshotIntervalMs(2)).toBe(240_000);
    expect(snapshotIntervalMs(5)).toBe(60_000 * 32);
    expect(snapshotIntervalMs(10)).toBe(60 * 60_000); // 2^10 = 17h, capped at 1h
    expect(snapshotIntervalMs(-3)).toBe(60_000); // junk-streak degrades to base
  });

  test("a sandbox with a skip streak is probed at the backed-off interval, not every minute", async () => {
    // streak=5 → 32min interval. An attempt 5 minutes ago is inside the interval, so the
    // tick must NOT probe: this is the cost saving — an idle sandbox stops paying for a
    // full-tree probe and an STS mint every minute.
    const id = await seedOri({
      snapshotSkipStreak: 5,
      lastSnapshotAttemptAt: new Date(Date.now() - 5 * 60_000),
    });
    const r = await tick(deps, new Date());
    expect(r.snapshotted + r.snapshotFailed).toBe(0);
    expect((await oriRow(id))?.lastSnapshotAttemptAt).not.toBeNull();
  });

  test("the same sandbox IS probed once its backed-off interval has elapsed", async () => {
    const id = await seedOri({
      snapshotSkipStreak: 5, // 32min interval
      lastSnapshotAttemptAt: new Date(Date.now() - 33 * 60_000),
    });
    const r = await tick(deps, new Date());
    expect(r.snapshotted + r.snapshotFailed).toBeGreaterThan(0);
    const row = await oriRow(id);
    expect(row?.snapshotSkipStreak).toBe(0); // a real backup resets the streak
    expect(row?.state).toBe("ready");
  });

  test("a fresh sandbox with an old attempt is probed at the base 60s interval", async () => {
    await seedOri({
      snapshotSkipStreak: 0,
      lastSnapshotAttemptAt: new Date(Date.now() - 120_000),
    });
    const r = await tick(deps, new Date());
    expect(r.snapshotted + r.snapshotFailed).toBeGreaterThan(0);
  });

  test("a failure resets the streak so the next probe is at the base cadence", async () => {
    // streak=7 → the 60min cap, attempt outside it, and this attempt fails. The failure
    // resets the streak to 0 (takeSnapshot), so the next probe is due at the base 60s
    // cadence rather than after another backed-off interval.
    const id = await seedOri({
      snapshotSkipStreak: 7,
      lastSnapshotAttemptAt: new Date(Date.now() - 70 * 60_000),
    });
    await breakAgent(id); // make this attempt fail
    const r = await tick(deps, new Date());
    expect(r.snapshotFailed).toBeGreaterThan(0);
    expect((await oriRow(id))?.snapshotSkipStreak).toBe(0);
  });

  test("a failure BEFORE the guest call resets the streak too", async () => {
    // The other failure path: credentials cannot be minted at all, so takeSnapshot never
    // reaches the guest. It registers the failure, and registering a failure is what resets
    // the streak — otherwise a sandbox with a broken object store would sit at the 60min
    // cadence while its backups were failing, which is the opposite of what backoff is for.
    const id = await seedOri({
      snapshotSkipStreak: 7,
      lastSnapshotAttemptAt: new Date(Date.now() - 70 * 60_000),
    });
    const endpoint = process.env.S3_ENDPOINT;
    process.env.S3_ENDPOINT = "http://127.0.0.1:1"; // STS unreachable, so the mint throws
    try {
      const r = await tick(deps, new Date());
      expect(r.snapshotFailed).toBeGreaterThan(0);
    } finally {
      if (endpoint === undefined) delete process.env.S3_ENDPOINT;
      else process.env.S3_ENDPOINT = endpoint;
    }
    const row = await oriRow(id);
    expect(row?.snapshotSkipStreak).toBe(0);
    expect(row?.lastSnapshotStatus).toBe("failed");
  });
});

describe("T-P5-05 a failed final snapshot keeps the ori alive and unbilled", () => {
  test("stop is refused; the ori stays up, the machine is not destroyed", async () => {
    const id = await seedOri();
    await breakAgent(id);
    const before = await oriRow(id);
    const outcome = await stopOri(deps, id, false);

    expect(outcome.ok).toBe(false);
    const row = await oriRow(id);
    expect(row?.state).not.toBe("archived");
    expect(row?.state).toBe(before!.state); // returned to where it was
    expect(row?.machineId).toBe(before!.machineId); // machine NOT destroyed
    expect(row?.lastSnapshotStatus).toBe("failed");
    expect(row?.snapshotAvailable).toBe(false);
  });

  test("and it accrues ZERO machine-seconds while in that state", async () => {
    const id = await seedOri();
    await breakAgent(id);
    await stopOri(deps, id, false); // leaves lastSnapshotStatus = failed
    expect((await oriRow(id))?.lastSnapshotStatus).toBe("failed");

    await tick(deps, new Date());

    // Assert the LEDGER, not the flag. The flag being right while the customer is billed
    // anyway is the failure they would actually notice, and a flag-only assertion sails
    // straight past it.
    const rows = await ledgerFor(id);
    expect(rows.length).toBeGreaterThan(0);
    const billed = rows.reduce((n, r) => n + Number(r.machineSeconds ?? 0), 0);
    expect(billed).toBe(0);
  });

  test("a healthy ori IS billed, so the zero above is not vacuous", async () => {
    // Without this, "billed === 0" could pass simply because accrual is broken for
    // everyone.
    const id = await seedOri({
      lastSnapshotStatus: "completed",
      lastSnapshotAttemptAt: new Date(Date.now() - 5_000),
      createdAt: new Date(Date.now() - 600_000),
    });
    await tick(deps, new Date());
    const billed = (await ledgerFor(id)).reduce((n, r) => n + Number(r.machineSeconds ?? 0), 0);
    expect(billed).toBeGreaterThan(0);
  });

  test("force:true skips the final snapshot and archives anyway", async () => {
    const id = await seedOri();
    const machineId = (await oriRow(id))!.machineId;
    const outcome = await stopOri(deps, id, true);
    expect(outcome.ok).toBe(true);
    const row = await oriRow(id);
    expect(row?.state).toBe("archived");
    // Warm stop: the container is halted in place and kept on host disk, so the row keeps its
    // machineId for a near-term resume to start. force:true changes the snapshot decision,
    // not the warm/cold one.
    expect(row?.machineId).toBe(machineId);
  });
});
