  /**
 * Server-side API key minting. The public API has no POST /api-keys, so keys
 * are created here against the control-plane database (hash-only storage, as
 * the auth middleware reads them).
 *
 * Usage:
 *   bun run scripts/create-key.ts --name "<label>"                 # auto user (random login)
 *   bun run scripts/create-key.ts --name "prod" --login octocat --email a@b.c
 *
 * Prints the raw secret ONCE; it is not stored and cannot be recovered later.
 */
import { parseArgs } from "node:util";
import { apiKeyId, apiKeySecret } from "@ori/contract";
import { sha256Hex } from "@ori/api/middleware/auth";
import { makeDb } from "@ori/api/db/client";
import { apiKeys, users } from "@ori/api/db/schema";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    login: { type: "string" },
    email: { type: "string" },
  },
});

const name = values.name;
if (!name) {
  console.error("error: --name is required");
  process.exit(1);
}

const db = makeDb();
const login = values.login ?? `svc_${Math.random().toString(36).slice(2, 10)}`;
const email = values.email ?? null;

let user = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.login, login) });
if (!user) {
  const id = `u_${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`;
  await db.insert(users).values({ id, login, email });
  user = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, id) });
}

const secret = apiKeySecret();
await db.insert(apiKeys).values({
  id: apiKeyId(),
  userId: user!.id,
  name,
  keyPrefix: "ori_live",
  keyLastFour: secret.slice(-4),
  hash: sha256Hex(secret),
});

console.log("ori_live key minted (store this once; it is not saved):");
console.log(JSON.stringify({ secret, name, login }, null, 2));
process.exit(0);