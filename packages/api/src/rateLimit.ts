import { and, eq, gte, lte, sql } from "drizzle-orm";
import { startsLog } from "./db/schema";
import type { Db } from "./db/client";
import type { StartKind } from "@ori/contract";

/** §4 defaults + global ceilings. */
export const PER_MIN_LIMIT = 10;
export const PER_DAY_LIMIT = 1500;
export const GLOBAL_PER_HOUR_LIMIT = 600;
export const GLOBAL_PER_DAY_LIMIT = 1500;

export type RateCheck = { ok: true } | { ok: false; code: "rate_limited" | "daily_limit_reached" | "start_limit_reached" };

/**
 * A create/fork/resume is one machine start. Per-account per-minute and
 * per-day limits apply first; then the platform-wide 600/h and 1500/day
 * ceilings. Returns the exact documented 429 code.
 *
 * All four windows come from ONE statement, and one is the number that matters. This runs on
 * every create/fork/resume, so four separate counts cost four round trips — but more importantly
 * they were four separate MVCC snapshots, which made "did all four windows see the same instant?"
 * a question to be approximated with an upper bound rather than one the database simply answered.
 * A single `count(*) filter (...)` per window over the widest bound is one index scan on
 * `starts_log_created_idx`, one snapshot, and no `to` plumbing.
 */
export async function checkCreationAllowed(db: Db, userId: string, now: Date): Promise<RateCheck> {
  const minuteAgo = new Date(now.getTime() - 60_000);
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);

  const [row] = await db
    .select({
      // `.toISOString()` and an explicit cast, not the Date itself: drizzle only serializes Dates
      // for comparisons it builds from a column type, and a raw fragment hands the JS Date
      // straight to the driver, which refuses it.
      userMinute: sql<number>`count(*) filter (where ${startsLog.userId} = ${userId} and ${startsLog.createdAt} >= ${minuteAgo.toISOString()}::timestamptz)::int`,
      userDay: sql<number>`count(*) filter (where ${startsLog.userId} = ${userId})::int`,
      globalHour: sql<number>`count(*) filter (where ${startsLog.createdAt} >= ${hourAgo.toISOString()}::timestamptz)::int`,
      globalDay: sql<number>`count(*)::int`,
    })
    .from(startsLog)
    // The day window is the widest of the four, so it bounds the scan and every narrower window
    // is a FILTER over the same rows. `<= now` keeps a start that lands mid-check out of all four.
    .where(and(gte(startsLog.createdAt, dayAgo), lte(startsLog.createdAt, now)));

  const { userMinute = 0, userDay = 0, globalHour = 0, globalDay = 0 } = row ?? {};

  // Tightest limit first: a user over both their per-minute rate and the fleet-wide daily cap is
  // told about the one they can actually do something about.
  if (userMinute >= PER_MIN_LIMIT) return { ok: false, code: "rate_limited" };
  if (userDay >= PER_DAY_LIMIT) return { ok: false, code: "daily_limit_reached" };
  if (globalHour >= GLOBAL_PER_HOUR_LIMIT) return { ok: false, code: "start_limit_reached" };
  if (globalDay >= GLOBAL_PER_DAY_LIMIT) return { ok: false, code: "start_limit_reached" };

  return { ok: true };
}

/** Record one machine start in the ledger. */
export async function recordStart(db: Db, userId: string, oriId: string, kind: StartKind, now: Date): Promise<void> {
  await db.insert(startsLog).values({ userId, oriId, kind, createdAt: now });
}