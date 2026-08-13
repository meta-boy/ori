import { createHmac } from "node:crypto";

/**
 * Per-ori machine/agent tokens.
 *
 * The DB keeps only sha256 hashes (`machine_token_hash`/`agent_token_hash`), which verify
 * INBOUND calls from a ori. But the control plane also has to make OUTBOUND calls to the guest
 * agent on :7777, and a hash cannot do that — it needs the raw token.
 *
 * This used to be an in-memory Map, which meant a control-plane restart orphaned every running
 * ori: the container kept running while `exec` returned gateway_error, `desktop` reported
 * machine_not_running on a ori reading `ready`, and `stop` could not reach the agent to take
 * the final snapshot — the one thing that makes stopping safe. A deploy would have stranded the
 * whole fleet.
 *
 * So the tokens are DERIVED from the server secret and the ori id instead of stored. Any
 * process holding the secret can recompute them, restarts included, and nothing is kept at
 * rest: a database read alone yields no usable credential. This mirrors how snapshot repository
 * passwords already work (docs/OPERATIONS.md).
 */
export interface OriTokens {
  machineToken: string;
  agentToken: string;
}

/**
 * A façade kept so callers read the same as before. There is nothing to store — `get` derives —
 * and `set`/`delete` exist only because create/fork/resume and the tests still call them.
 */
export class TokenStore {
  /** Derived, so this never misses and never goes stale across a restart. */
  get(oriId: string): OriTokens {
    return { machineToken: machineToken(oriId), agentToken: agentToken(oriId) };
  }

  /**
   * Accepts and ignores. The tokens for a ori id are a pure function of the secret, so there is
   * no state to record; a caller passing something else would be passing a token no ori has.
   */
  set(_oriId: string, _tokens: OriTokens): void {}

  /** Nothing is retained, so there is nothing to forget when a ori is destroyed. */
  delete(_oriId: string): void {}

  clear(): void {}
}

/** Hex chars in a token body. 32 chars = 128 bits. */
export const TOKEN_HEX_LEN = 32;

// Validators live HERE, beside the generators, and are built from the same constant, so
// the two cannot drift. They did: machineAuth.ts had its own /^ori_mt_[0-9a-f]{64}$/,
// which no token this file produces can ever match, making /internal/oris/:id/* 401 for
// every ori in production. Its unit tests passed because they hand-wrote a 64-char token.
export const MACHINE_TOKEN_REGEX = new RegExp(`^ori_mt_[0-9a-f]{${TOKEN_HEX_LEN}}$`);
export const AGENT_TOKEN_REGEX = new RegExp(`^ori_at_[0-9a-f]{${TOKEN_HEX_LEN}}$`);

/**
 * Key id baked into every derivation.
 *
 * It is here from the first version deliberately. Without one, changing the secret orphans
 * every ori at once and there is no way to keep old oris working while new ones use a new
 * key — which is exactly the trap the snapshot repo passwords are in
 * (docs/OPEN-DECISIONS.md #1). Bump this and keep resolving old oris with the old id.
 */
export const TOKEN_KEY_ID = "v1";

function secret(): string {
  // Reuses the snapshot secret: it is already mandatory, already documented as the
  // deployment's crown jewel, and a second required secret is one more thing to forget.
  const s = process.env.ORI_SNAPSHOT_SECRET;
  if (!s) throw new Error("ORI_SNAPSHOT_SECRET is not set; cannot derive ori tokens");
  return s;
}

/**
 * Derive a token for one ori. Two oris never collide, and `kind` is inside the signed input so
 * a machine token can never equal the agent token of the same ori.
 */
function derive(kind: "mt" | "at", oriId: string): string {
  const mac = createHmac("sha256", secret())
    .update(`ori-${kind}-token:${TOKEN_KEY_ID}:${oriId}`)
    .digest("hex");
  return `ori_${kind}_${mac.slice(0, TOKEN_HEX_LEN)}`;
}

/** Per-ori control-plane credential, scoped to `/internal/oris/<own-id>/*`. */
export function machineToken(oriId: string): string {
  return derive("mt", oriId);
}

/** Per-ori credential the control plane uses to call the guest on :7777. */
export function agentToken(oriId: string): string {
  return derive("at", oriId);
}
