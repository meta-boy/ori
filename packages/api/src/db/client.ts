import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://ori:ori@localhost:5432/ori";

/** Raw postgres-js connection for migrations / admin queries. */
export function postgresClient(url: string = DATABASE_URL) {
  return postgres(url, { max: 1 });
}

/**
 * Drizzle ORM over the §6 schema.
 *
 * One pool serves request handlers and the reaper tick, and the reaper fans out (per-ori
 * ledger reads and writes, snapshot work) while requests are mid-flight. max:5 let a busy
 * request burst stall the whole reaper behind it; twenty is headroom for that contention
 * without letting a single process saturate the local Postgres.
 */
export function makeDb(url: string = DATABASE_URL) {
  return drizzle(postgres(url, { max: 20 }), { schema });
}

export type Db = ReturnType<typeof makeDb>;