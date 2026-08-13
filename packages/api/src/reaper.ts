import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { BILLABLE, MACHINE_TABLE, RUNNABLE, type MachineType, type OriState } from "@ori/contract";
import { oriMetrics, oris, snapshots } from "./db/schema";
import type { AppDeps } from "./context";
import type { BatchCapableDriver, WarmFootprintDriver } from "./drivers/types";
import { stopOri } from "./lifecycle/stop";
import { closeUsageLedger } from "./lifecycle/ledger";
import { emitOriEvent } from "./lifecycle/events";
import { GuestClient } from "./guest/client";
import { agentToken } from "./tokens";
import { takeSnapshot } from "./snapshots/take";
import { applyRetentionToFleet } from "./snapshots/retention";
import { pruneSessions } from "./routes/auth";

/**
 * A ori stuck on a failed final snapshot accrues ZERO for
 * 30 minutes — it keeps running (so its work is not discarded) but unbilled.
 */
const FAILED_SNAPSHOT_ZERO_WINDOW_MS = 30 * 60 * 1000;

/**
 * How long a ori may sit in `archiving` before this tick resolves it.
 *
 * The final snapshot is blocking and can legitimately take minutes on a full disk, so the
 * window has to be comfortably longer than a real archive — it deliberately matches
 * FAILED_SNAPSHOT_ZERO_WINDOW_MS, which exists for the same "is this slow or dead?" reason.
 */
const STUCK_ARCHIVING_MS = Number(process.env.ORI_STUCK_ARCHIVING_MS ?? FAILED_SNAPSHOT_ZERO_WINDOW_MS);

/**
 * Auto-snapshot cadence: every minute while a ori is idle, plus one when it stops. Driven
 * from this tick rather than a second timer, so nothing races it over the rows it writes.
 *
 * `housekeeping` is the one other clock in the system, and it is deliberately confined to rows
 * this tick never writes — see its doc comment.
 */
const AUTO_SNAPSHOT_INTERVAL_MS = 60_000;

/**
 * Idle backoff ceiling. A sandbox whose disk never changes costs a full-tree lstat probe
 * plus a credential mint per attempt, and probing every minute forever wastes both.
 * Each consecutive skip doubles the interval; anything that changes the disk resets the
 * streak and the cadence. The cap keeps the worst-case snapshot staleness bounded: a change
 * is captured at the next probe, so no more than MAX later.
 */
export const MAX_AUTO_SNAPSHOT_INTERVAL_MS = 60 * 60_000;

/**
 * Cadence for a sandbox that has skipped `streak` consecutive auto-snapshots.
 *
 * Clamped at both ends: the column is a NOT NULL non-negative integer, but this is also the
 * function the cadence tests read the curve off, and a curve that silently returns something
 * below the base interval for junk input would be worse than one that says 60s.
 */
export function snapshotIntervalMs(streak: number): number {
  return Math.min(AUTO_SNAPSHOT_INTERVAL_MS * 2 ** Math.max(0, Math.floor(streak)), MAX_AUTO_SNAPSHOT_INTERVAL_MS);
}

/** States worth snapshotting: the ori is up and its disk can change. */
const SNAPSHOTTABLE: readonly OriState[] = ["ready", "idle", "running"];

/** States in which a live machine is expected; anything else is terminal/transitional. */
const EXPECT_LIVE_MACHINE: readonly OriState[] = [
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
];

export interface ReapReport {
  /** Resource samples recorded this tick. */
  sampled?: number;
  autoStopped: number;
  snapshotted: number;
  /** Snapshots the guest declined because nothing had changed. Not failures. */
  snapshotSkipped: number;
  snapshotFailed: number;
  accrued: number;
  zeroAccrued: number;
  markedError: number;
  /** Expired VNC desktops torn back down. */
  desktopsStopped: number;
}

/**
 * One reaper pass at `now`. Ordering matters: auto-stop first (so stopped
 * oris stop being BILLABLE before accrual), then accrue, then liveness.
 */
export async function tick(deps: AppDeps, now: Date): Promise<ReapReport> {
  const report: ReapReport = { autoStopped: 0, snapshotted: 0, snapshotSkipped: 0, snapshotFailed: 0, accrued: 0, zeroAccrued: 0, markedError: 0, desktopsStopped: 0 };

  // 1. Auto-stop overdue oris (archive_after in the past) via the graceful
  //    snapshot-then-destroy path; stopOri emits its own events.
  const overdue = await deps.db.query.oris.findMany({
    where: and(
      inArray(oris.state, [...RUNNABLE, "running"]),
      isNotNull(oris.archiveAfter),
      lt(oris.archiveAfter, now),
    ),
  });
  for (const ori of overdue) {
    const outcome = await stopOri(deps, ori.id, false);
    if (outcome.ok) report.autoStopped++;
  }

  // 2. Auto-snapshot any up ori whose last attempt is older than the interval. Runs BEFORE
  //    accrual, so a ori whose snapshot just failed is zero-rated in the same tick that
  //    discovered the failure rather than being billed for it once.
  //    A failure here never takes the ori down; it is recorded and retried next tick.
  const snapshottable = await deps.db.query.oris.findMany({
    where: inArray(oris.state, [...SNAPSHOTTABLE]),
  });
  for (const ori of snapshottable) {
    const last = ori.lastSnapshotAttemptAt?.getTime() ?? 0;
    // Per-ori cadence: an idle sandbox that keeps answering "skipped" doubles its interval
    // on every skip, so a fleet that is not writing anything stops paying for minute-level
    // probes. A change (or a failure) resets the streak, and the streak lives on the ori
    // row, so a restart cannot forget it.
    if (now.getTime() - last < snapshotIntervalMs(ori.snapshotSkipStreak)) continue;
    const outcome = await takeSnapshot(deps, ori.id, "auto", now);
    // Exhaustive on purpose: a skip is neither new data to count nor a failure to zero-rate, and
    // counting it as `snapshotted` would report an idle fleet as a busy one.
    switch (outcome.status) {
      case "created":
        report.snapshotted++;
        break;
      case "skipped":
        report.snapshotSkipped++;
        break;
      case "failed":
        report.snapshotFailed++;
        break;
    }
  }

  // 3. Accrue machine-seconds for every BILLABLE ori over the elapsed interval.
    const billable = await deps.db.query.oris.findMany({
    where: inArray(oris.state, [...BILLABLE]),
  });
  for (const ori of billable) {
    const failedRecently =
      ori.lastSnapshotStatus === "failed" &&
      ori.lastSnapshotAttemptAt != null &&
      now.getTime() - ori.lastSnapshotAttemptAt.getTime() < FAILED_SNAPSHOT_ZERO_WINDOW_MS;
    if (failedRecently) {
      // Record the interval's seconds but accrue ZERO machine-seconds, and
      // advance the toTs baseline so billing never backfills the unbilled gap.
      await closeUsageLedger(deps.db, { id: ori.id, userId: ori.userId, type: ori.type, createdAt: ori.createdAt }, now, { multiplier: 0 });
      await emitOriEvent(deps.db, ori.id, "usage.accrued", { data: { seconds: Math.max(0, Math.floor((now.getTime() - ori.createdAt.getTime()) / 1000)), multiplier: 0, machineSeconds: 0, zeroRated: true } });
      report.zeroAccrued++;
    } else {
      await closeUsageLedger(deps.db, { id: ori.id, userId: ori.userId, type: ori.type, createdAt: ori.createdAt }, now);
      report.accrued++;
    }
  }

  // 4. A ori that should have a live machine, but whose machine is reported
  //    dead, goes to error.
  //
  //  The liveness check is batched when the driver can do it: one `docker ps` answers for
  //  the whole fleet where per-ori `isAlive` would spawn one docker CLI process per ori per
  //  tick. A driver without the batch capability (the fake, and Incus until it gets one)
  //  falls back to per-ori isAlive; a batch failure also falls back, so a docker hiccup
  //  degrades to the slow path rather than to marking machines dead. That fallback is why
  //  listAliveIds is specified to THROW rather than answer with an empty set when the
  //  backend cannot be reached — see BatchCapableDriver.
  const batch = deps.driver as BatchCapableDriver;
  const aliveIds = batch.listAliveIds ? await batch.listAliveIds().catch(() => null) : null;
  const live = await deps.db.query.oris.findMany({
    where: and(
      inArray(oris.state, [...EXPECT_LIVE_MACHINE]),
      isNotNull(oris.machineId),
    ),
  });
  for (const ori of live) {
    const alive = aliveIds ? aliveIds.has(ori.machineId!) : await deps.driver.isAlive(ori.machineId!);
    if (!alive) {
      await deps.db
        .update(oris)
        .set({ state: "error", error: "machine reported dead", updatedAt: now })
        .where(eq(oris.id, ori.id));
      await emitOriEvent(deps.db, ori.id, "ori.error", { data: { error: "machine reported dead" } });
      report.markedError++;
    }
  }

  // 4b. A stop that never finished.
  //
  //  `archiving` is BILLABLE, which makes it undeletable (delete refuses ACTIVE states with
  //  ori_not_deletable), and `stop` refuses to re-enter it (machine_not_running). Step 4 above
  //  cannot see these rows either: it requires a non-null machineId, and the archive path nulls
  //  that as soon as it destroys the machine. So a ori whose archive died mid-flight was
  //  reachable by nothing at all — billable, unresumable and undeletable, forever. Observed on a
  //  live deployment: a row stuck for five days that no API call could move.
  //
  //  Resolution follows the data rather than guessing. With a completed snapshot the disk is
  //  safe and `archived` is simply the truth, so the ori stays resumable. Without one there is
  //  nothing to come back to, and `error` says so — and both states can be deleted.
  const stuckArchiving = await deps.db.query.oris.findMany({
    where: and(eq(oris.state, "archiving"), lt(oris.updatedAt, new Date(now.getTime() - STUCK_ARCHIVING_MS))),
  });
  for (const ori of stuckArchiving) {
    const snap = await deps.db.query.snapshots.findFirst({
      where: and(eq(snapshots.oriId, ori.id), eq(snapshots.status, "completed")),
      orderBy: desc(snapshots.generation),
    });
    const resolved = snap ? "archived" : "error";
    await deps.db
      .update(oris)
      .set({
        state: resolved,
        ...(snap ? {} : { error: "archive never completed and no snapshot exists" }),
        updatedAt: now,
      })
      .where(and(eq(oris.id, ori.id), eq(oris.state, "archiving")));
    await emitOriEvent(deps.db, ori.id, snap ? "ori.archived" : "ori.error", {
      data: snap
        ? { reason: "archive did not complete; resolved from the latest completed snapshot" }
        : { error: "archive never completed and no snapshot exists" },
    });
    if (!snap) report.markedError++;
  }

  // 5. Shut down desktops whose access token has expired. The guest brings the VNC stack up on
  //    demand but nothing ever brought it back down, so one visit to the desktop tab left Xvfb,
  //    the window manager and x11vnc running under software GL — with blanking disabled — for the
  //    rest of the sandbox's life. The token expiring is the signal that nobody can be watching.
  const expiredDesktops = await deps.db.query.oris.findMany({
    where: and(
      eq(oris.desktopAvailable, true),
      isNotNull(oris.desktopExpiresAt),
      lt(oris.desktopExpiresAt, now),
      isNotNull(oris.ip),
    ),
  });
  for (const ori of expiredDesktops) {
    // Clear the flags whether or not the guest answers. An unreachable agent means the desktop
    // is already gone with its container; leaving the row saying otherwise would retry forever.
    await GuestClient.forIp(ori.ip!, agentToken(ori.id))
      .desktopStop()
      .catch(() => undefined);
    await deps.db
      .update(oris)
      .set({ desktopAvailable: false, desktopToken: null, desktopExpiresAt: null, updatedAt: now })
      .where(eq(oris.id, ori.id));
    report.desktopsStopped++;
  }

  // 6. Resource samples for the sparklines. Last, and never fatal: a metrics failure must not
  //    stop the reaper doing the work that actually matters (auto-stop, snapshots, billing).
  report.sampled = await sampleMetrics(deps, now).catch(() => 0);

  return report;
}

/** What one housekeeping pass reclaimed. */
export interface HousekeepingReport {
  sessionsPruned: number;
  snapshotsForgotten: number;
  /** Repos whose retention pass failed — usually a repo lock held by a concurrent backup. */
  retentionFailed: number;
  /** Whether this pass also pruned, the half that actually returns bytes to the object store. */
  pruned: boolean;
  /** Warm containers destroyed because their ori has been archived past WARM_KEEP_MS. */
  warmEvicted: number;
  /** Warm containers destroyed by the ORI_WARM_MAX_BYTES host-disk budget, oldest archived first. */
  warmBytesEvicted: number;
}

/**
 * The monthly `prune` window: the 1st of the month, in the 03:00 UTC hour.
 *
 * `forget` unlinks snapshots but frees nothing; only `prune` rewrites the packs, and it is
 * expensive enough that it wants a schedule of its own. Derived from the clock rather than a
 * counter so a restart cannot reset the schedule, and so a test can hit it by passing a date.
 *
 * ponytail: the hourly sweep is phase-aligned to process start, not to the hour, so a process
 * that restarts often enough to never fire inside the 03:00 hour on the 1st will skip a month.
 * The upgrade is a persisted last-pruned-at; not worth the column while a missed month costs
 * only deferred disk.
 */
export function isPruneWindow(now: Date): boolean {
  return now.getUTCDate() === 1 && now.getUTCHours() === 3;
}

/**
 * How long an archived ori's warm container stays on host disk before housekeeping evicts it.
 *
 * A warm container is a cache, restic is the truth — so this is a DISK-reclaim timer, not a
 * durability one. Env var WARM_KEEP_MS; default 24h. Junk input degrades to the default.
 */
export function warmKeepMs(): number {
  const DEFAULT_WARM_KEEP_MS = 24 * 60 * 60 * 1000;
  const raw = process.env.WARM_KEEP_MS;
  if (!raw) return DEFAULT_WARM_KEEP_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WARM_KEEP_MS;
}

/**
 * Evict warm containers whose ori has been archived past WARM_KEEP_MS.
 *
 * Only evicts after confirming a registered snapshot exists. Without restic behind it, the
 * stopped container is the ONLY copy of the disk (a force-stopped ori that never snapshotted),
 * and destroying it would lose data — warm is a cache, and a cache without its backing store
 * must not be dropped. After eviction the ori is exactly what it always was: cold, restic-only.
 *
 * Deliberately part of housekeeping, not tick: destroying a container is host I/O with no
 * billing or snapshot implications, and folding it into the per-minute tick would add work to
 * the path that has to stay quick. `now` is injectable so a test can age an ori past the window.
 */
export async function evictWarmContainers(deps: AppDeps, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - warmKeepMs());
  const stale = await deps.db.query.oris.findMany({
    where: and(eq(oris.state, "archived"), isNotNull(oris.machineId), lt(oris.updatedAt, cutoff)),
  });
  let evicted = 0;
  for (const ori of stale) {
    // "archived + machineId != null" is the warm state; updatedAt is the archive time — stop
    // writes it and nothing else touches an archived row, so it cannot drift.
    const registered = await deps.db.query.snapshots.findFirst({
      where: eq(snapshots.oriId, ori.id),
      columns: { id: true },
    });
    if (!registered) continue;
    await deps.driver.destroy(ori.machineId!).catch(() => {});
    await deps.db.update(oris).set({ machineId: null, ip: null, updatedAt: now }).where(eq(oris.id, ori.id));
    await emitOriEvent(deps.db, ori.id, "ori.evicted", { data: { reason: "warm window expired" } });
    evicted++;
  }
  return evicted;
}

/**
 * Host-disk budget for the warm tier, in bytes. Env var ORI_WARM_MAX_BYTES, parsed as an
 * integer. Unset, 0, or junk input = unlimited (the default).
 */
export function warmMaxBytes(): number {
  const raw = process.env.ORI_WARM_MAX_BYTES;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Evict warm containers to hold the fleet under the ORI_WARM_MAX_BYTES host-disk budget.
 *
 * Runs AFTER the age rule in housekeeping, over the containers that survived it. Both are
 * host-disk reclaim, but they answer different questions: the age rule bounds how long a warm
 * container lingers, this bounds how much host disk the whole warm tier may occupy. A driver
 * without warmFootprint, or an unset budget, changes nothing.
 *
 * Oldest archived first — deliberately NOT fattest-first. The budget is about the SUM, so the
 * ordering is the knob that keeps recently-used sandboxes on the fast resume path while still
 * making room; dropping the fattest containers would evict the freshest work to save the oldest.
 *
 * Same destroy-the-container path and registered-snapshot guard as the age rule: without a
 * restic copy the stopped container is the ONLY copy of the disk, and a cache without its
 * backing store must not be dropped — budget or no budget.
 */
export async function evictWarmBytes(deps: AppDeps, now: Date): Promise<number> {
  const budget = warmMaxBytes();
  if (budget === 0) return 0;
  const driver = deps.driver as Partial<WarmFootprintDriver>;
  if (typeof driver.warmFootprint !== "function") return 0;

  const footprint = await driver.warmFootprint();
  if (footprint.size === 0) return 0;

  // Only warm oris the control plane still knows: the footprint may answer for machines whose
  // ori is gone or already evicted by the age rule, and only an archived ori is evictable.
  const warm = await deps.db.query.oris.findMany({
    where: and(inArray(oris.machineId, [...footprint.keys()]), eq(oris.state, "archived")),
  });

  const evictable: { ori: (typeof warm)[number]; bytes: number; archivedAtMs: number | null }[] = [];
  for (const ori of warm) {
    const entry = footprint.get(ori.machineId!);
    if (!entry) continue;
    const registered = await deps.db.query.snapshots.findFirst({
      where: eq(snapshots.oriId, ori.id),
      columns: { id: true },
    });
    if (!registered) continue;
    evictable.push({ ori, bytes: entry.bytes, archivedAtMs: entry.archivedAtMs });
  }

  // Oldest archived first; updatedAt is the archive time and stands in when the driver cannot
  // read one (archivedAtMs null).
  evictable.sort(
    (a, b) => (a.archivedAtMs ?? a.ori.updatedAt.getTime()) - (b.archivedAtMs ?? b.ori.updatedAt.getTime()),
  );

  let total = evictable.reduce((sum, m) => sum + m.bytes, 0);
  let evicted = 0;
  for (const m of evictable) {
    if (total <= budget) break;
    await deps.driver.destroy(m.ori.machineId!).catch(() => {});
    await deps.db.update(oris).set({ machineId: null, ip: null, updatedAt: now }).where(eq(oris.id, m.ori.id));
    await emitOriEvent(deps.db, m.ori.id, "ori.evicted", { data: { reason: "warm byte budget exceeded" } });
    total -= m.bytes;
    evicted++;
  }
  return evicted;
}

/**
 * Sweep expired sessions, apply snapshot retention across the fleet, and evict warm containers
 * past their window.
 *
 * Three jobs on three scales, which is the thing to understand here: `forget` runs every pass
 * and only unlinks snapshots, while `prune` — the half that actually returns bytes to the
 * object store — runs once a month (`isPruneWindow`). An hourly pass that never pruned would
 * keep the row count honest and the storage bill untouched. The warm eviction is the host-disk
 * half of the same reclaim: it returns a container's writable layer to the host, guarded by the
 * existence of a registered snapshot.
 *
 * Deliberately NOT part of `tick`. This talks to object storage, so folding it into the
 * per-minute pass would put network I/O on the path that has to stay quick enough to bill and
 * auto-stop on time — and would make every unit test of `tick` reach for a real repo.
 *
 * Safe to run alongside a tick despite the one-clock rule: it only ever deletes sessions that
 * have already expired and snapshot rows that restic has already forgotten, neither of which a
 * tick writes. A snapshot taken concurrently is newer than the retention window, so it cannot be
 * in the forget set. The one genuine contention is restic's own repo lock, which the guest's 60s
 * backup also takes — see `applyRetentionToFleet` for why losing that race is safe.
 */
export async function housekeeping(deps: AppDeps, now: Date): Promise<HousekeepingReport> {
  const sessionsPruned = await pruneSessions(deps, now).catch(() => 0);
  const prune = isPruneWindow(now);
  const retention = await applyRetentionToFleet(deps, { prune });
  const warmEvicted = await evictWarmContainers(deps, now);
  const warmBytesEvicted = await evictWarmBytes(deps, now);
  return {
    sessionsPruned,
    snapshotsForgotten: retention.rowsDeleted,
    retentionFailed: retention.failed,
    pruned: prune,
    warmEvicted,
    warmBytesEvicted,
  };
}

/** How many samples to keep per sandbox. At a 60s tick that is roughly the last hour. */
export const MAX_METRIC_SAMPLES = 60;

/**
 * Record one resource sample per running sandbox, then prune.
 *
 * One driver call for the whole fleet (see DockerMachineDriver.sampleStats), one INSERT, and a
 * DELETE that keeps only the newest MAX_METRIC_SAMPLES rows per ori. Pruning here rather than in
 * a separate job means the table cannot grow unbounded through neglect.
 *
 * A driver without sampleStats (the fake one, and Incus until it gets an implementation) simply
 * contributes nothing, and the dashboard shows no data rather than fabricated flat lines.
 */
export async function sampleMetrics(deps: AppDeps, now: Date): Promise<number> {
  const driver = deps.driver as BatchCapableDriver;
  if (typeof driver.sampleStats !== "function") return 0;

  const samples = await driver.sampleStats();
  if (samples.size === 0) return 0;

  // Only sandboxes we still have rows for: a container the control plane no longer knows about
  // would violate the foreign key, and cascade-delete means a destroyed ori takes its series.
  const known = await deps.db.query.oris.findMany({
    where: inArray(oris.state, [...EXPECT_LIVE_MACHINE]),
    columns: { id: true, type: true },
  });
  const knownTypes = new Map(known.map((o) => [o.id, o.type]));

  const rows = [...samples.entries()]
    .filter(([oriId]) => knownTypes.has(oriId))
    .map(([oriId, s]) => ({
      oriId,
      at: now,
      ...s,
      // The quota, not the host's filesystem: only this layer knows the sandbox's type, and
      // "30% of your 50GB" is the reading a user can act on.
      diskTotalBytes: (MACHINE_TABLE[knownTypes.get(oriId) as MachineType]?.usableGB ?? 0) * 1e9,
    }));
  if (rows.length === 0) return 0;

  await deps.db.insert(oriMetrics).values(rows);

  /*
   * Prune per sandbox, keeping the newest N. A window function beats N round trips.
   *
   * Restricted to the ids just inserted, because only they can have gained a row: ranking the
   * whole table meant every tick re-sorted the series of every sandbox that had ever run, so the
   * cost grew with history rather than with the fleet actually running. The (ori_id, at) index
   * serves the partition directly.
   */
  const sampledIds = rows.map((r) => r.oriId);
  await deps.db.execute(sql`
    delete from ${oriMetrics}
    where id in (
      select id from (
        select id, row_number() over (partition by ori_id order by at desc) as rn
        from ${oriMetrics}
        where ori_id in (${sql.join(sampledIds.map((id) => sql`${id}`), sql`, `)})
      ) ranked
      where ranked.rn > ${MAX_METRIC_SAMPLES}
    )
  `);

  return rows.length;
}

/**
 * Start the reaper loop. `intervalMs` is injectable so tests can control the
 * cadence; each fire calls `tick` with the real wall clock. Returns a stop
 * handle. Tests must call `tick(deps, now)` directly instead of running this.
 */
export function start(deps: AppDeps, intervalMs = 60_000, housekeepingMs = 60 * 60_000): () => void {
  /*
   * A pass that outlives its interval must not be joined by the next one.
   *
   * For the tick this is a billing guarantee, not a nicety. Its slowest step is a stop that waits
   * on a final snapshot, so a large fleet can push one pass past 60s; two overlapping ticks then
   * race on the usage ledger, because `closeUsageLedger` reads the last `to_ts` and inserts the
   * interval since it with no lock — both read the same baseline and the same seconds get billed
   * twice.
   *
   * Skipping is correct rather than queueing. Accrual is derived from the ledger's own `to_ts`
   * rather than from how often this fired, so the next pass bills the whole elapsed span; and
   * auto-stop is driven by `archive_after` being in the past, which stays true until acted on.
   * A missed pass costs latency, never money or state.
   *
   * Errors are swallowed per pass so one bad pass cannot kill the timer — without the catch, a
   * rejected tick would be an unhandled rejection on the billing path.
   */
  const every = (ms: number, run: () => Promise<unknown>): ReturnType<typeof setInterval> => {
    let inProgress = false;
    return setInterval(() => {
      if (inProgress) return;
      inProgress = true;
      void run()
        .catch(() => undefined)
        .finally(() => {
          inProgress = false;
        });
    }, ms);
  };

  const timer = every(intervalMs, () => tick(deps, new Date()));
  const sweeper = every(housekeepingMs, () => housekeeping(deps, new Date()));

  return () => {
    clearInterval(timer);
    clearInterval(sweeper);
  };
}
