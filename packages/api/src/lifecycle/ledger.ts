import { desc, eq } from "drizzle-orm";
import { MACHINE_TABLE, type MachineType } from "@ori/contract";
import { usageLedger } from "../db/schema";
import type { Db } from "../db/client";

/**
 * Write a usage_ledger row for a ori: from the ori's creation (or the last
 * recorded tick) until `to`, scaled by the type's billing multiplier. This is
 * the single ledger-writing path; the reaper (T-P3-08) and stop both use it.
 *
 * `opts.multiplier` overrides the machine-type multiplier. The reaper passes
 * 0 for a ori stuck on a failed final snapshot so that
 * interval records its seconds but accrues ZERO machine-seconds, and the
 * `toTs` baseline still advances so billing never backfills the unbilled gap.
 */
export async function closeUsageLedger(
  db: Db,
  ori: { id: string; userId: string; type: string; createdAt: Date },
  to: Date,
  opts: { multiplier?: number } = {},
): Promise<void> {
  const last = await db.query.usageLedger.findFirst({
    where: eq(usageLedger.oriId, ori.id),
    orderBy: desc(usageLedger.toTs),
  });
  const from = last?.toTs ?? ori.createdAt;
  const seconds = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
  const multiplier = opts.multiplier ?? MACHINE_TABLE[ori.type as MachineType]?.billingMultiplier ?? 1;
  await db.insert(usageLedger).values({
    oriId: ori.id,
    userId: ori.userId,
    fromTs: from,
    toTs: to,
    seconds,
    multiplier,
    machineSeconds: Math.round(seconds * multiplier),
  });
}
