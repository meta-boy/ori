/**
 * Apply pending migrations without dropping anything.
 * Usage: `bun run packages/api/scripts/migrate.ts`.
 */
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { fileURLToPath } from "node:url";
import { DATABASE_URL, postgresClient } from "../src/db/client";
import * as schema from "../src/db/schema";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const sql = postgresClient(DATABASE_URL);
await migrate(drizzle(sql, { schema }), { migrationsFolder });
console.log("db:migrate complete");
await sql.end();