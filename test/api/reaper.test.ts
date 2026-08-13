import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { fileURLToPath } from "node:url";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore } from "./helpers";
import { oriEnv, oris, oriEvents, snapshots, startsLog, usageLedger, users } from "@ori/api/db/schema";
import { oriId, machineFor } from "@ori/contract";
import { postgresClient, type Db } from "@ori/api/db/client";
import { tick, evictWarmContainers, evictWarmBytes } from "@ori/api/reaper";

// The reaper scans EVERY ori, but parallel test files each run their own
// FakeMachineDriver, so oris other files create would look "dead" to this
// file's driver. Give the reaper its own throwaway database to keep the
// scan isolated from the shared dev DB.
const DB_NAME = `ori_reaper_${Date.now().toString(36)}`;
const ADMIN_URL = "postgres://ori:ori@localhost:5432/ori";
const DB_URL = `postgres://ori:ori@localhost:5432/${DB_NAME}`;

const migrationsFolder = fileURLToPath(new URL("../../packages/api/drizzle", import.meta.url));

let db: Db;
const driver = new FakeMachineDriver();
const tokens = new TokenStore();
let deps: { db: Db; driver: FakeMachineDriver; tokens: TokenStore };
let app: ReturnType<typeof buildApp>;

let key: Awaited<ReturnType<typeof seedUserKey>>;

const ORIS = "/api/ori/v1/oris";

const T0 = new Date("2026-01-01T00:00:00Z");

function sec(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

async function freshKey() {
  return seedUserKey(db);
}

async function create(secret = key.secret) {
  const res = await app.request(ORIS, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
  });
  const json = await res.json();
  expect(json.ok).toBe(true);
  return json.ori as { id: string };
}

async function waitForState(id: string, state: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    if (row?.state === state) return;
    await Bun.sleep(20);
  }
  const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
  throw new Error(`ori ${id} never reached ${state}; last=${row?.state}`);
}

async function deleteOri(id: string): Promise<void> {
  await db.delete(oriEvents).where(eq(oriEvents.oriId, id));
  await db.delete(snapshots).where(eq(snapshots.oriId, id));
  await db.delete(oriEnv).where(eq(oriEnv.oriId, id));
  await db.delete(usageLedger).where(eq(usageLedger.oriId, id));
  await db.delete(startsLog).where(eq(startsLog.oriId, id));
  await db.delete(oris).where(eq(oris.id, id));
}

beforeAll(async () => {
  const admin = postgresClient(ADMIN_URL);
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  await migrate(drizzle(postgresClient(DB_URL), { schema: { users } }), { migrationsFolder });
  db = makeDb(DB_URL);

  deps = { db, driver, tokens };
  app = buildApp(deps);
  key = await seedUserKey(db);
});

afterAll(async () => {
  await driver.stopAll();
  const admin = postgresClient(ADMIN_URL);
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.end();
});

describe("stuck archiving", () => {
  // A live deployment had a row stuck in `archiving` for five days: BILLABLE (so `delete`
  // refused it), not re-enterable by `stop`, and invisible to the dead-machine sweep because
  // that requires a non-null machineId which the archive path had already cleared.
  const wedge = async (id: string) =>
    db.update(oris).set({ state: "archiving", machineId: null, ip: null, updatedAt: sec(-31 * 60_000) }).where(eq(oris.id, id));

  test("resolves to archived when a completed snapshot exists, so the ori stays resumable", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await db.insert(snapshots).values({ id: crypto.randomUUID(), oriId: ori.id, generation: 1, kind: "base", status: "completed" });
    await wedge(ori.id);

    await tick(deps, T0);

    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.state).toBe("archived");
    await deleteOri(ori.id);
  });

  test("resolves to error when there is no snapshot to come back to", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await wedge(ori.id);

    await tick(deps, T0);

    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.state).toBe("error");
    expect(row?.error).toContain("archive never completed");
    await deleteOri(ori.id);
  });

  test("leaves a recent archiving ori alone — a real final snapshot takes minutes", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await db.update(oris).set({ state: "archiving", machineId: null, updatedAt: sec(-60_000) }).where(eq(oris.id, ori.id));

    await tick(deps, T0);

    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.state).toBe("archiving");
    await deleteOri(ori.id);
  });
});

describe("T-P3-08 reaper tick", () => {
  test("auto-stops a ori whose archive_after is in the past", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    // push archive_after into the past
    await db.update(oris).set({ archiveAfter: sec(-60_000) }).where(eq(oris.id, ori.id));

    await tick(deps, T0);

    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.state).toBe("archived");
    // events prove the graceful path ran
    const events = await db.select().from(oriEvents).where(eq(oriEvents.oriId, ori.id));
    expect(events.map((e) => e.type)).toContain("ori.archiving");
    expect(events.map((e) => e.type)).toContain("ori.archived");
    await deleteOri(ori.id);
  });

  test("does NOT auto-stop a ori whose archive_after is still in the future", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");

    await tick(deps, T0);
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.state).toBe("ready");
    await deleteOri(ori.id);
  });

  test("only auto-stops runnable/running oris, not archived ones", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await db.update(oris).set({ archiveAfter: sec(-60_000) }).where(eq(oris.id, ori.id));

    // a second, already-archived ori with a stale archive_after must not be re-stopped
    const archivedId = oriId();
    await db.insert(oris).values({
      id: archivedId,
      userId: k.userId,
      name: "already archived",
      state: "archived",
      type: "default",
      archiveAfter: sec(-60_000),
      createdAt: sec(-3600_000),
      updatedAt: sec(-3600_000),
    });

    await tick(deps, T0);
    expect((await db.query.oris.findFirst({ where: eq(oris.id, ori.id) }))?.state).toBe("archived");
    const archived = await db.query.oris.findFirst({ where: eq(oris.id, archivedId) });
    expect(archived?.state).toBe("archived");
    await deleteOri(ori.id);
    await deleteOri(archivedId);
  });

  test("accrues machine-seconds = elapsed seconds × type multiplier for BILLABLE oris", async () => {
    const k = await freshKey();
    // seed a ready ori directly so we control createdAt precisely
    const id = oriId();
    const createdAt = sec(-7200_000); // 2h before T0
    await db.insert(oris).values({
      id,
      userId: k.userId,
      name: "billable small",
      state: "ready",
      type: "small", // multiplier 0.5
      createdAt,
      updatedAt: createdAt,
    });

    await tick(deps, T0);

    const rows = await db.select().from(usageLedger).where(eq(usageLedger.oriId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].seconds).toBe(7200);
    expect(rows[0].multiplier).toBe(machineFor("small").billingMultiplier);
    expect(rows[0].machineSeconds).toBe(7200 * 0.5);
    await deleteOri(id);
  });

  test("accumulates across ticks without double-counting the elapsed window", async () => {
    const k = await freshKey();
    const id = oriId();
    const createdAt = sec(-3600_000); // 1h before T0
    await db.insert(oris).values({
      id,
      userId: k.userId,
      name: "tick twice",
      state: "running",
      type: "large", // multiplier 2
      createdAt,
      updatedAt: createdAt,
    });

    await tick(deps, T0); // first tick: 3600s
    await tick(deps, sec(60_000)); // second tick: +60s more

    const rows = await db.select().from(usageLedger).where(eq(usageLedger.oriId, id)).orderBy(asc(usageLedger.id));
    expect(rows).toHaveLength(2);
    const totalSeconds = rows.reduce((n, r) => n + r.seconds, 0);
    expect(totalSeconds).toBe(3660);
    const totalMs = rows.reduce((n, r) => n + r.machineSeconds, 0);
    expect(totalMs).toBe(3660 * 2);
    await deleteOri(id);
  });

  test("zero-rates a ori stuck on a failed final snapshot for under 30 minutes", async () => {
    const k = await freshKey();
    const id = oriId();
    const createdAt = sec(-600_000);
    await db.insert(oris).values({
      id,
      userId: k.userId,
      name: "stuck 10m",
      state: "ready",
      type: "default",
      createdAt,
      updatedAt: createdAt,
      lastSnapshotStatus: "failed",
      lastSnapshotAttemptAt: sec(-600_000), // 10 min ago
    });

    await tick(deps, T0);

    const rows = await db.select().from(usageLedger).where(eq(usageLedger.oriId, id));
    expect(rows).toHaveLength(1);
    // seconds are recorded (so the baseline advances) but machine-seconds are ZERO
    expect(rows[0].seconds).toBeGreaterThan(0);
    expect(rows[0].machineSeconds).toBe(0);
    const ev = await db.select().from(oriEvents).where(eq(oriEvents.oriId, id));
    expect(ev.map((e) => e.type)).toContain("usage.accrued");
    await deleteOri(id);
  });

  test("bills normally once a failed snapshot is older than 30 minutes", async () => {
    const k = await freshKey();
    const id = oriId();
    const createdAt = sec(-3600_000);
    await db.insert(oris).values({
      id,
      userId: k.userId,
      name: "stuck 40m",
      state: "ready",
      type: "default",
      createdAt,
      updatedAt: createdAt,
      lastSnapshotStatus: "failed",
      lastSnapshotAttemptAt: sec(-2400_000), // 40 min ago → outside window
    });

    await tick(deps, T0);

    const rows = await db.select().from(usageLedger).where(eq(usageLedger.oriId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].machineSeconds).toBe(3600);
    await deleteOri(id);
  });

  test("does not accrue for archived/error oris", async () => {
    const k = await freshKey();
    const archivedId = oriId();
    const errorId = oriId();
    await db.insert(oris).values([
      {
        id: archivedId,
        userId: k.userId,
        name: "archived",
        state: "archived",
        type: "default",
        createdAt: sec(-3600_000),
        updatedAt: sec(-3600_000),
      },
      {
        id: errorId,
        userId: k.userId,
        name: "error",
        state: "error",
        type: "default",
        createdAt: sec(-3600_000),
        updatedAt: sec(-3600_000),
      },
    ]);

    await tick(deps, T0);
    expect(await db.select().from(usageLedger).where(eq(usageLedger.oriId, archivedId))).toHaveLength(0);
    expect(await db.select().from(usageLedger).where(eq(usageLedger.oriId, errorId))).toHaveLength(0);
    await deleteOri(archivedId);
    await deleteOri(errorId);
  });

  test("marks a ori error when its machine is reported dead", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    const machineId = row!.machineId!;
    // kill the machine out from under the ori
    await driver.destroy(machineId);

    await tick(deps, T0);
    const after = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(after?.state).toBe("error");
    expect(after?.error).toMatch(/dead/);
    const events = await db.select().from(oriEvents).where(eq(oriEvents.oriId, ori.id));
    expect(events.map((e) => e.type)).toContain("ori.error");
    await deleteOri(ori.id);
  });

  test("leaves healthy machines alone", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await tick(deps, T0);
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row?.state).toBe("ready");
    await deleteOri(ori.id);
  });

  test("uses the driver's batch liveness when present, and never falls back per-ori", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    const machineId = row!.machineId!;

    // A driver that reports the fleet in ONE listAliveIds call and is otherwise useless:
    // the tick must consult the batch and never call per-ori isAlive, and a machine absent
    // from the batch is dead. Object.create keeps the fake's prototype methods; a spread
    // would lose them (they live on the prototype).
    let listCalls = 0;
    let isAliveCalls = 0;
    const batchDriver = Object.assign(Object.create(driver), {
      listAliveIds: async () => {
        listCalls++;
        return new Set<string>();
      },
      isAlive: async () => {
        isAliveCalls++;
        return true;
      },
    });

    await tick({ ...deps, driver: batchDriver as unknown as typeof driver }, T0);

    expect(listCalls).toBe(1);
    expect(isAliveCalls).toBe(0);
    const after = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(after?.state).toBe("error");
    expect(after?.error).toMatch(/dead/);
    await deleteOri(ori.id);
  });

  test("falls back to per-ori isAlive when the driver has no batch capability", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    const machineId = row!.machineId!;
    // Kill the machine out from under the ori: the FakeMachineDriver has no listAliveIds,
    // so the tick must use isAlive and see it dead.
    await driver.destroy(machineId);

    await tick(deps, T0);
    const after = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(after?.state).toBe("error");
    await deleteOri(ori.id);
  });

  test("a failed batch liveness degrades to per-ori isAlive rather than marking machines dead", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");

    const flakyDriver = Object.assign(Object.create(driver), {
      listAliveIds: async () => {
        throw new Error("docker ps exploded");
      },
    });
    await tick({ ...deps, driver: flakyDriver as unknown as typeof driver }, T0);

    // Machine is actually alive; per-ori isAlive says so; the ori stays ready.
    const after = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(after?.state).toBe("ready");
    await deleteOri(ori.id);
  });

  /*
   * The desktop is the most expensive thing a sandbox can leave running — Xvfb plus a window
   * manager plus x11vnc, under software GL, with blanking disabled — and until the reaper swept
   * them nothing ever turned one off. The token expiring is the signal nobody can be watching.
   */
  test("stops a desktop whose token has expired and clears the row", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await db
      .update(oris)
      .set({ desktopAvailable: true, desktopToken: "dt", desktopExpiresAt: sec(-1000) })
      .where(eq(oris.id, ori.id));

    const report = await tick(deps, T0);

    expect(report.desktopsStopped).toBe(1);
    const after = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(after?.desktopAvailable).toBe(false);
    expect(after?.desktopToken).toBeNull();
    expect(after?.desktopExpiresAt).toBeNull();
    // The sandbox itself is untouched: only the desktop went away.
    expect(after?.state).toBe("ready");
    await deleteOri(ori.id);
  });

  test("leaves an unexpired desktop running", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await db
      .update(oris)
      .set({ desktopAvailable: true, desktopToken: "dt", desktopExpiresAt: sec(3_600_000) })
      .where(eq(oris.id, ori.id));

    const report = await tick(deps, T0);

    expect(report.desktopsStopped).toBe(0);
    const after = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(after?.desktopAvailable).toBe(true);
    await deleteOri(ori.id);
  });
});

describe("warm tier eviction", () => {
  // WARM_KEEP_MS is read from the environment; the isolated DB keeps these rows out of the
  // shared dev DB so the reaper's global scan cannot see them either way.
  const OLD_KEEP = process.env.WARM_KEEP_MS;
  beforeAll(() => {
    process.env.WARM_KEEP_MS = "3600000"; // 1h
  });
  afterAll(() => {
    if (OLD_KEEP === undefined) delete process.env.WARM_KEEP_MS;
    else process.env.WARM_KEEP_MS = OLD_KEEP;
  });

  /** Seed a warm-archived ori: state archived, machineId kept, updatedAt in the past. */
  async function seedWarmArchived(k: Awaited<ReturnType<typeof freshKey>>, updatedAtMs: number, machineId: string | null) {
    const id = oriId();
    await db.insert(oris).values({
      id,
      userId: k.userId,
      name: "warm",
      state: "archived",
      type: "default",
      machineId,
      createdAt: sec(-3600_000),
      updatedAt: sec(updatedAtMs),
    });
    return id;
  }

  test("evicts a warm container past the window once a snapshot is registered", async () => {
    const k = await freshKey();
    const machine = await driver.create({
      oriId: "or_machine_probe",
      type: "default",
      image: "ubuntu-24.04",
      machineToken: "mt",
      agentToken: "at",
    });
    const id = await seedWarmArchived(k, -7200_000, machine.machineId); // 2h ago > 1h window
    await db.insert(snapshots).values({ id: crypto.randomUUID(), oriId: id, generation: 1, kind: "base", status: "completed" });

    const evicted = await evictWarmContainers(deps, T0);

    expect(evicted).toBe(1);
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    expect(row?.machineId).toBeNull();
    expect(row?.ip).toBeNull();
    expect(await driver.exists(machine.machineId)).toBe(false); // container actually gone
    await deleteOri(id);
  });

  test("leaves a warm container with NO snapshot alone (its disk has no restic copy)", async () => {
    const k = await freshKey();
    const machine = await driver.create({
      oriId: "or_machine_probe",
      type: "default",
      image: "ubuntu-24.04",
      machineToken: "mt",
      agentToken: "at",
    });
    const id = await seedWarmArchived(k, -7200_000, machine.machineId);

    const evicted = await evictWarmContainers(deps, T0);

    expect(evicted).toBe(0);
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    expect(row?.machineId).toBe(machine.machineId); // still warm; nothing to restore from
    expect(await driver.exists(machine.machineId)).toBe(true);
    await deleteOri(id);
  });

  test("leaves a warm container inside the window alone", async () => {
    const k = await freshKey();
    const machine = await driver.create({
      oriId: "or_machine_probe",
      type: "default",
      image: "ubuntu-24.04",
      machineToken: "mt",
      agentToken: "at",
    });
    const id = await seedWarmArchived(k, -600_000, machine.machineId); // 10min ago < 1h window
    await db.insert(snapshots).values({ id: crypto.randomUUID(), oriId: id, generation: 1, kind: "base", status: "completed" });

    const evicted = await evictWarmContainers(deps, T0);

    expect(evicted).toBe(0);
    expect(await driver.exists(machine.machineId)).toBe(true);
    await deleteOri(id);
  });
});

describe("warm byte-budget eviction", () => {
  // ORI_WARM_MAX_BYTES is read from the environment per call; restore it after every test.
  const ORIGINAL_MAX = process.env.ORI_WARM_MAX_BYTES;
  const ORIGINAL_KEEP = process.env.WARM_KEEP_MS;
  beforeAll(() => {
    process.env.WARM_KEEP_MS = "86400000"; // 24h: keep the age rule out of these tests
  });
  afterEach(() => {
    if (ORIGINAL_MAX === undefined) delete process.env.ORI_WARM_MAX_BYTES;
    else process.env.ORI_WARM_MAX_BYTES = ORIGINAL_MAX;
  });
  afterAll(() => {
    if (ORIGINAL_KEEP === undefined) delete process.env.WARM_KEEP_MS;
    else process.env.WARM_KEEP_MS = ORIGINAL_KEEP;
  });

  const OLD = T0.getTime() - 2 * 3600_000; // archived 2h ago
  const MID = T0.getTime() - 90 * 60_000; // archived 1h30m ago
  const NEW = T0.getTime() - 60 * 60_000; // archived 1h ago

  /** A warm-archived ori: stopped container on disk, registered snapshot, injected footprint. */
  async function warmMachine(k: Awaited<ReturnType<typeof freshKey>>, bytes: number, archivedAtMs: number) {
    const machine = await driver.create({
      oriId: "or_machine_probe",
      type: "default",
      image: "ubuntu-24.04",
      machineToken: "mt",
      agentToken: "at",
    });
    await driver.stop(machine.machineId); // stopped = warm: on host disk, not running
    driver.warmFootprintByMachine.set(machine.machineId, { bytes, archivedAtMs });
    const id = oriId();
    await db.insert(oris).values({
      id,
      userId: k.userId,
      name: "warm-bytes",
      state: "archived",
      type: "default",
      machineId: machine.machineId,
      createdAt: sec(-3600_000),
      updatedAt: new Date(archivedAtMs),
    });
    await db.insert(snapshots).values({ id: crypto.randomUUID(), oriId: id, generation: 1, kind: "base", status: "completed" });
    return { id, machineId: machine.machineId };
  }

  test("leaves everything warm when the footprint is under budget", async () => {
    const k = await freshKey();
    process.env.ORI_WARM_MAX_BYTES = "2000";
    const m = await warmMachine(k, 500, OLD);

    const evicted = await evictWarmBytes(deps, T0);

    expect(evicted).toBe(0);
    expect(await driver.exists(m.machineId)).toBe(true);
    const row = await db.query.oris.findFirst({ where: eq(oris.id, m.id) });
    expect(row?.machineId).toBe(m.machineId);
    await deleteOri(m.id);
  });

  test("evicts oldest-first until the fleet is back under budget", async () => {
    const k = await freshKey();
    process.env.ORI_WARM_MAX_BYTES = "800";
    // Total is 1300 > 800. Oldest-first must take the 2h and 1h30m machines (freeing 800,
    // leaving 500) — never the fattest 1h one, which is exactly what a fattest-first policy
    // would have dropped.
    const oldest = await warmMachine(k, 400, OLD);
    const middle = await warmMachine(k, 400, MID);
    const newest = await warmMachine(k, 500, NEW);

    const evicted = await evictWarmBytes(deps, T0);

    expect(evicted).toBe(2);
    expect(await driver.exists(oldest.machineId)).toBe(false); // oldest gone
    expect(await driver.exists(middle.machineId)).toBe(false); // next-oldest gone
    expect(await driver.exists(newest.machineId)).toBe(true); // newest, though fattest, kept
    const oldestRow = await db.query.oris.findFirst({ where: eq(oris.id, oldest.id) });
    expect(oldestRow?.machineId).toBeNull();
    const newestRow = await db.query.oris.findFirst({ where: eq(oris.id, newest.id) });
    expect(newestRow?.machineId).toBe(newest.machineId);
    await deleteOri(oldest.id);
    await deleteOri(middle.id);
    await deleteOri(newest.id);
  });

  test("never byte-evicts a warm machine with no registered snapshot", async () => {
    const k = await freshKey();
    process.env.ORI_WARM_MAX_BYTES = "1"; // any warm footprint blows the budget
    const machine = await driver.create({
      oriId: "or_machine_probe",
      type: "default",
      image: "ubuntu-24.04",
      machineToken: "mt",
      agentToken: "at",
    });
    await driver.stop(machine.machineId);
    driver.warmFootprintByMachine.set(machine.machineId, { bytes: 100, archivedAtMs: OLD });
    const id = oriId();
    await db.insert(oris).values({
      id,
      userId: k.userId,
      name: "warm-no-snapshot",
      state: "archived",
      type: "default",
      machineId: machine.machineId,
      createdAt: sec(-3600_000),
      updatedAt: new Date(OLD),
    });

    const evicted = await evictWarmBytes(deps, T0);

    expect(evicted).toBe(0);
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    expect(row?.machineId).toBe(machine.machineId); // still warm; nothing to restore from
    expect(await driver.exists(machine.machineId)).toBe(true);
    await deleteOri(id);
  });

  test("leaves everything warm when ORI_WARM_MAX_BYTES is unset", async () => {
    const k = await freshKey();
    delete process.env.ORI_WARM_MAX_BYTES;
    const m = await warmMachine(k, 10_000_000_000, OLD); // absurd bytes, still untouched

    const evicted = await evictWarmBytes(deps, T0);

    expect(evicted).toBe(0);
    expect(await driver.exists(m.machineId)).toBe(true);
    await deleteOri(m.id);
  });

  test("a budget of 0 is unlimited", async () => {
    const k = await freshKey();
    process.env.ORI_WARM_MAX_BYTES = "0";
    const m = await warmMachine(k, 10_000_000_000, OLD);

    const evicted = await evictWarmBytes(deps, T0);

    expect(evicted).toBe(0);
    expect(await driver.exists(m.machineId)).toBe(true);
    await deleteOri(m.id);
  });

  test("leaves everything warm for a driver without warmFootprint", async () => {
    const k = await freshKey();
    process.env.ORI_WARM_MAX_BYTES = "1";
    const m = await warmMachine(k, 500, OLD);
    // A driver that cannot report a warm footprint: shadow the prototype method with an own
    // undefined so the reaper's capability probe sees nothing.
    const noFootprint = Object.assign(Object.create(driver), { warmFootprint: undefined });

    const evicted = await evictWarmBytes({ ...deps, driver: noFootprint as unknown as typeof driver }, T0);

    expect(evicted).toBe(0);
    expect(await driver.exists(m.machineId)).toBe(true);
    await deleteOri(m.id);
  });
});
