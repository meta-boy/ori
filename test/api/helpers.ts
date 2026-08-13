// Test-only. Production MUST fail without this (docs/OPERATIONS.md: a code default would
// silently share one repo password across every deployment that forgot to set it). Tests
// need a stable value because stop/auto-stop now take a real final snapshot, and a ori
// that cannot be saved is correctly refused rather than archived.
process.env.ORI_SNAPSHOT_SECRET ??= "test-only-snapshot-secret";

import { createApp } from "@ori/api/app";
import { makeDb } from "@ori/api/db/client";
import type { Db } from "@ori/api/db/client";
import type { AppDeps } from "@ori/api/context";
import { FakeMachineDriver } from "@ori/api/drivers/fake";
import { TokenStore } from "@ori/api/tokens";
import { apiKeyId, apiKeySecret } from "@ori/contract";
import { sha256Hex } from "@ori/api/middleware/auth";
import { apiKeys, users } from "@ori/api/db/schema";

export { createApp, makeDb, FakeMachineDriver, TokenStore };
export type { Db, AppDeps };

/** Unique suffix so parallel/repeated runs never collide on shared rows. */
export function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildDeps(over: Partial<AppDeps> = {}): AppDeps {
  return { db: makeDb(), driver: new FakeMachineDriver(), tokens: new TokenStore(), ...over };
}

export function buildApp(over: Partial<AppDeps> = {}) {
  return createApp(buildDeps(over));
}

export interface SeededKey {
  userId: string;
  login: string;
  email: string;
  keyId: string;
  secret: string;
  name: string;
}

const hex = () => Math.random().toString(16).slice(2, 10);

/** Insert a fresh user + active API key, returning the one-time raw secret. */
export async function seedUserKey(db: Db, opts: { revoked?: boolean } = {}): Promise<SeededKey> {
  const userId = `u_${hex()}${hex()}`;
  const login = uniq("octocat");
  const email = `${login}@example.com`;
  const secret = apiKeySecret();
  const keyId = apiKeyId();
  const name = "Test key " + hex();

  await db.insert(users).values({ id: userId, login, email }).onConflictDoNothing();
  await db
    .insert(apiKeys)
    .values({
      id: keyId,
      userId,
      name,
      keyPrefix: "ori_live",
      keyLastFour: secret.slice(-4),
      hash: sha256Hex(secret),
      revokedAt: opts.revoked ? new Date() : null,
    })
    .onConflictDoNothing();
  return { userId, login, email, keyId, secret, name };
}
/**
 * Delete a ori and everything that references it, in FK order. Use this in teardown
 * instead of hand-rolling the delete chain: three separate test files have now failed with
 * `violates foreign key constraint` because a new table started referencing oris (ori_events
 * when events landed, snapshots when stop began registering one) and their local cleanup
 * did not know about it. One place to update beats finding them one failure at a time.
 */
export async function deleteOriCascade(db: Db, oriId: string): Promise<void> {
  const s = await import("@ori/api/db/schema");
  const { eq, inArray } = await import("drizzle-orm");
  const snaps = await db.select({ id: s.snapshots.id }).from(s.snapshots).where(eq(s.snapshots.oriId, oriId));
  if (snaps.length > 0) {
    await db.delete(s.snapshotChunks).where(inArray(s.snapshotChunks.snapshotId, snaps.map((x) => x.id)));
  }
  await db.delete(s.snapshots).where(eq(s.snapshots.oriId, oriId));
  await db.delete(s.oriEvents).where(eq(s.oriEvents.oriId, oriId));
  await db.delete(s.oriEnv).where(eq(s.oriEnv.oriId, oriId));
  await db.delete(s.promptRuns).where(eq(s.promptRuns.oriId, oriId));
  await db.delete(s.portRoutes).where(eq(s.portRoutes.oriId, oriId));
  await db.delete(s.oriMetrics).where(eq(s.oriMetrics.oriId, oriId));
  await db.delete(s.usageLedger).where(eq(s.usageLedger.oriId, oriId));
  await db.delete(s.startsLog).where(eq(s.startsLog.oriId, oriId));
  await db.delete(s.oris).where(eq(s.oris.id, oriId));
}
