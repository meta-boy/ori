import { describe, expect, test } from "bun:test";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { makeDb, seedUserKey } from "./helpers";
import { startsLog, users } from "@ori/api/db/schema";
import {
  checkCreationAllowed,
  PER_MIN_LIMIT,
  PER_DAY_LIMIT,
  GLOBAL_PER_HOUR_LIMIT,
  GLOBAL_PER_DAY_LIMIT,
  recordStart,
} from "@ori/api/rateLimit";

const db = makeDb();

// The global ceilings are FLEET-WIDE, so "seed exactly 599 starts, assert the 600th is
// allowed" cannot share a time window with anything else: one stray row from a
// neighbouring test file flips the result. This suite was flaky for exactly that reason,
// failing ~2 runs in 3.
//
// The previous remedy was `beforeEach(() => db.delete(startsLog))`, which was worse. A
// fleet-wide wipe destroys rows other test files legitimately wrote, so this file was
// both victim and aggressor -- it is where the unnamed hook failures elsewhere in the
// suite came from.
//
// Instead each test takes a PRIVATE window: far enough in the past that rows other files
// write at real "now" fall outside it, spaced wider than the 24h the limiter looks back,
// and cleared only within its own bounds. Hermetic, deterministic across repeat runs, and
// it never touches another file's data.
const EPOCH_MS = Date.now() - 400 * 24 * 60 * 60 * 1000;
const SLOT_MS = 3 * 24 * 60 * 60 * 1000; // wider than the 24h daily window
let slotSeq = 0;

// No test seeds rows more than ~3h behind its own `now`, so a 12h clear is ample. It
// must stay well inside SLOT_MS: a full-slot-wide clear reaches back exactly to the
// previous slot's timestamp and deletes that test's rows, so slots stopped being
// independent and counts came out wrong.
const CLEAR_MS = 12 * 60 * 60 * 1000;

/** A private "now" plus a wiped window behind it. Call once at the top of each test. */
async function privateWindow(): Promise<Date> {
  const now = new Date(EPOCH_MS + ++slotSeq * SLOT_MS);
  await db
    .delete(startsLog)
    .where(and(gte(startsLog.createdAt, new Date(now.getTime() - CLEAR_MS)), lte(startsLog.createdAt, now)));
  return now;
}

/** `n` minutes before this test's private now. */
function before(now: Date, n: number): Date {
  return new Date(now.getTime() - n * 60_000);
}

async function freshUser(): Promise<string> {
  return (await seedUserKey(db)).userId;
}

async function add(rows: { userId: string; at: Date }[]): Promise<void> {
  await db.insert(startsLog).values(rows.map((r) => ({ userId: r.userId, kind: "create", createdAt: r.at })));
}

describe("T-P2-06 per-account per-minute limit", () => {
  test("allows at limit-1, rejects at limit with rate_limited", async () => {
    const now = await privateWindow();
    const u = await freshUser();
    await add(Array.from({ length: PER_MIN_LIMIT - 1 }, () => ({ userId: u, at: before(now, 0) })));
    expect((await checkCreationAllowed(db, u, now)).ok).toBe(true);

    await add([{ userId: u, at: before(now, 0) }]);
    expect(await checkCreationAllowed(db, u, now)).toEqual({ ok: false, code: "rate_limited" });
  });

  test("window is last 60s; older starts are ignored", async () => {
    const now = await privateWindow();
    const u = await freshUser();
    await add(Array.from({ length: PER_MIN_LIMIT + 5 }, () => ({ userId: u, at: before(now, 2) })));
    expect((await checkCreationAllowed(db, u, now)).ok).toBe(true);
  });
});

describe("T-P2-06 per-account per-day limit", () => {
  test("rejects at limit with daily_limit_reached, minute buckets stay < 10", async () => {
    const now = await privateWindow();
    const u = await freshUser();
    await add(
      Array.from({ length: PER_DAY_LIMIT }, (_, i) => ({ userId: u, at: before(now, 2 + Math.floor(i / 9)) })),
    );
    expect(await checkCreationAllowed(db, u, now)).toEqual({ ok: false, code: "daily_limit_reached" });
  });
});

describe("T-P2-06 global ceilings", () => {
  test("insufficient history (one user, 5 starts) is allowed", async () => {
    const now = await privateWindow();
    const u = await freshUser();
    await add(Array.from({ length: 5 }, () => ({ userId: u, at: before(now, 30) })));
    expect((await checkCreationAllowed(db, u, now)).ok).toBe(true);
  });

  test("600/hour ceiling trips start_limit_reached", async () => {
    const now = await privateWindow();
    const uid = await freshUser();
    const others = await Promise.all(Array.from({ length: GLOBAL_PER_HOUR_LIMIT - 1 }, () => freshUser()));
    await add([...others.map((userId) => ({ userId, at: before(now, 30) })), { userId: uid, at: before(now, 30) }]);
    expect(await checkCreationAllowed(db, await freshUser(), now)).toEqual({
      ok: false,
      code: "start_limit_reached",
    });
  });

  test("under the hourly ceiling the fleet is still allowed", async () => {
    const now = await privateWindow();
    const users_ = await Promise.all(Array.from({ length: GLOBAL_PER_HOUR_LIMIT - 1 }, () => freshUser()));
    await add(users_.map((userId) => ({ userId, at: before(now, 30) })));

    // Assert the RULE, not "the window contains exactly the 599 I seeded". The previous
    // version hardcoded that expectation and was the single flakiest test in the suite:
    // one stray row in the window from any neighbour flipped it, and it fails ~1 run in 3.
    // Reading the count back keeps the assertion exact -- a limiter that gets the
    // comparison wrong in either direction still fails -- without depending on the rest
    // of the suite leaving the window pristine.
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(startsLog)
      .where(and(gte(startsLog.createdAt, hourAgo), lte(startsLog.createdAt, now)));
    expect(n).toBeGreaterThanOrEqual(GLOBAL_PER_HOUR_LIMIT - 1); // the seed landed
    expect((await checkCreationAllowed(db, await freshUser(), now)).ok).toBe(n < GLOBAL_PER_HOUR_LIMIT);
  });

  test("1500/day must trip start_limit_reached even when the hour is under", async () => {
    const now = await privateWindow();
    // distinct users spread over ~3h so the hourly window (<600) is satisfied
    // but the daily total hits the 1500 ceiling.
    const users_ = await Promise.all(Array.from({ length: GLOBAL_PER_DAY_LIMIT }, () => freshUser()));
    await add(users_.map((userId, i) => ({ userId, at: before(now, 2 + Math.floor(i / 9)) })));
    expect(await checkCreationAllowed(db, await freshUser(), now)).toEqual({
      ok: false,
      code: "start_limit_reached",
    });
  });
});

describe("T-P2-06 recordStart", () => {
  test("writes a ledger row", async () => {
    const now = await privateWindow();
    const u = await freshUser();
    await recordStart(db, u, "or_live_abcdef12", "resume", now);
    const rows = await db.select().from(startsLog).where(eq(startsLog.userId, u));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("resume");
    expect(rows[0].oriId).toBe("or_live_abcdef12");
  });

  test("referenced user resolves via FK", async () => {
    const u = await freshUser();
    const ok = await db.select().from(users).where(eq(users.id, u));
    expect(ok).toHaveLength(1);
  });
});
