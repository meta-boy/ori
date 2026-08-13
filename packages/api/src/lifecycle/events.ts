import { oriEvents } from "../db/schema";
import type { PgDatabase } from "drizzle-orm/pg-core";

export interface EmitEventOpts {
  id?: string | null;
  taskId?: string | null;
  data?: Record<string, unknown>;
}

type EventDb = PgDatabase<any, any, any>;

/**
 * Append a lifecycle event to a ori's stream. `timestamp` is epoch millis and
 * `seq` is assigned by the bigserial column, which is what cursor pagination
 * walks. Lifecycle types emitted by the P3 transitions:
 *   ori.created · ori.ready · ori.archiving · ori.archived · ori.stop_failed
 *   ori.resuming · ori.restoring · ori.cloning
 *
 * `db` is typed as the common `PgDatabase` base so both the control-plane
 * `Db` and a `transaction` callback can be passed.
 */
export async function emitOriEvent(
  db: EventDb,
  oriId: string,
  type: string,
  opts: EmitEventOpts = {},
): Promise<void> {
  await db.insert(oriEvents).values({
    oriId,
    id: opts.id ?? null,
    type,
    timestamp: Date.now(),
    taskId: opts.taskId ?? null,
    data: opts.data ?? {},
  });
}
