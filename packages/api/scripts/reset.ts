/**
 * db:reset — drop every object in the `public` schema and re-apply migrations.
 *
 * Usage: `bun run packages/api/scripts/reset.ts` (root script: `db:reset`).
 */
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { fileURLToPath } from "node:url";
import { DATABASE_URL, postgresClient } from "../src/db/client";
import * as schema from "../src/db/schema";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const sql = postgresClient(DATABASE_URL);
const db = drizzle(sql, { schema });

console.log("dropping public schema…");
await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
await sql.unsafe("CREATE SCHEMA public");
await sql.unsafe("GRANT ALL ON SCHEMA public TO public");

// The migration journal lives in its OWN schema (drizzle.__drizzle_migrations), so
// dropping `public` alone left the journal behind. migrate() then treated every
// migration as already applied, skipped all of them, and printed "db:reset complete"
// over a database with zero tables. Every DB-backed test then failed with
// `relation "users" does not exist` -- while reset reported success. Drop the journal
// too, so a reset actually resets.
console.log("dropping drizzle migration journal…");
await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");

console.log(`applying migrations from ${migrationsFolder}…`);
await migrate(db, { migrationsFolder });
console.log("db:reset complete");
await sql.end();