/**
 * Mint a sign-up invite.
 *
 *   bun scripts/create-invite.ts                          # never expires
 *   bun scripts/create-invite.ts --days 7 --note "anurag"
 *
 * Sign-up is invite-only because this control plane is built to be reachable through a tunnel,
 * and every account that exists can spawn containers on the host. An invite is the difference
 * between "my dashboard" and "a free container farm for anyone who finds the URL".
 *
 * The token is printed once and only its sha256 is stored, so this output is the only copy.
 */
import { randomBytes } from "node:crypto";
import { sha256Hex } from "@ori/contract";
import { makeDb } from "@ori/api/db/client";
import { invites } from "@ori/api/db/schema";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const days = flag("days") ? Number(flag("days")) : null;
if (days !== null && (!Number.isFinite(days) || days <= 0)) {
  console.error("error: --days must be a positive number");
  process.exit(1);
}
const note = flag("note") ?? null;

const token = `inv_${randomBytes(24).toString("base64url")}`;
const id = `invt_${randomBytes(8).toString("hex")}`;
const expiresAt = days === null ? null : new Date(Date.now() + days * 86_400_000);

const db = makeDb();
await db.insert(invites).values({ id, tokenHash: sha256Hex(token), note, expiresAt });

console.log("invite minted (store this once; only its hash is saved):");
console.log(JSON.stringify({ invite: token, expiresAt: expiresAt?.toISOString() ?? null, note }, null, 2));
console.log("\nSign up at /dashboard with this invite. It is single-use.");

// postgresClient() would open a SECOND connection and close that one, leaving
// makeDb()'s pool open and the process hanging after printing the invite — which it
// did, silently, until infra/lxc/ori.sh started calling this at the end of an install.
// create-key.ts ends the same way for the same reason.
process.exit(0);
