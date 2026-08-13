import { eq } from "drizzle-orm";
import { parseEnvContents, type SecretFile } from "@ori/contract";
import { accountSecrets, oriEnv, oris } from "../db/schema";
import type { AppDeps } from "../context";
import { GuestClient, GuestError } from "../guest/client";

/**
 * Apply a ori's EFFECTIVE environment to its guest agent: the account-level
 * secrets (env vars + secret files, withheld entirely for no-env oris), then
 * the per-box env vars on top (per-box values win on name conflicts).
 *
 * This is the single path that turns the stored secret setup into a live
 * machine state. Before it existed the rows were written and read back but
 * never delivered: GET/POST /secrets and the oriEnv table were a silent
 * no-op against the actual sandbox.
 *
 * Returns {ok:true} with counts, or {ok:false, reason} — a failure here is
 * never fatal to the ori (a usable box without secrets beats a stuck one,
 * and POST /secrets can re-push), but it IS surfaced in events and in the
 * pushed.failed counter so it is not invisible either.
 */
export type ApplyEnvResult =
  | { ok: true; vars: number; files: number }
  | { ok: false; reason: string };

export async function applyEnvToOri(deps: AppDeps, oriId: string): Promise<ApplyEnvResult> {
  const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  if (!row) return { ok: false, reason: "ori not found" };
  if (!row.ip) return { ok: false, reason: "machine not running" };
  const tokens = deps.tokens.get(oriId);
  if (!tokens) return { ok: false, reason: "no machine tokens" };

  // Account-level setup is withheld entirely from no-env oris; per-box env
  // vars are NOT account secrets, so they apply to every ori that has them.
  const vars = new Map<string, string>();
  const files: SecretFile[] = [];
  if (!row.noEnv) {
    const acct = await deps.db.query.accountSecrets.findFirst({ where: eq(accountSecrets.userId, row.userId) });
    if (acct) {
      for (const [k, v] of parseEnvContents(acct.envContents ?? undefined)) vars.set(k, v);
      files.push(...(acct.secretFiles ?? []));
    }
  }
  const envRows = await deps.db.select().from(oriEnv).where(eq(oriEnv.oriId, oriId));
  for (const r of envRows) vars.set(r.key, r.value);

  const guest = GuestClient.forIp(row.ip, tokens.agentToken);
  try {
    await guest.env(Object.fromEntries(vars), files);
    return { ok: true, vars: vars.size, files: files.length };
  } catch (e) {
    return { ok: false, reason: e instanceof GuestError ? e.message : (e as Error).message };
  }
}
