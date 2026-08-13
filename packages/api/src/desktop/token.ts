import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Desktop access tokens.
 *
 * x11vnc inside a ori runs with no password, and noVNC serves anyone who can reach it. So the
 * entire security model for a desktop is (a) 6080 is published on loopback only, and (b) this
 * token. It is therefore worth being careful about:
 *
 *   - HMAC-signed and self-describing, so the proxy can validate without a database round
 *     trip on every asset request a browser makes.
 *   - Bound to ONE ori id. A token for ori A must be useless against ori B, or a shared
 *     desktop link becomes a key to the whole fleet.
 *   - Short-lived, and the expiry is inside the signed payload rather than checked separately,
 *     so it cannot be extended by editing the URL.
 *   - Compared in constant time. The token travels in a query string, which means it lands in
 *     logs and browser history; that is bad enough without also leaking it by timing.
 */

/** How long a freshly minted desktop URL stays usable. */
export const DESKTOP_TOKEN_TTL_SECONDS = 3600;

export interface DesktopTokenPayload {
  oriId: string;
  /** Unix seconds. */
  exp: number;
}

function secret(): string {
  // Reuses the snapshot secret deliberately: it is already required, already documented as
  // the deployment's crown jewel (docs/OPERATIONS.md), and adding a second mandatory secret
  // gains nothing while doubling what an operator can forget to set.
  const s = process.env.ORI_SNAPSHOT_SECRET;
  if (!s) throw new Error("ORI_SNAPSHOT_SECRET is not set; cannot sign desktop tokens");
  return s;
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(`desktop:${body}`).digest("base64url");
}

/** Mint a token for one ori, valid for `ttlSeconds`. */
export function mintDesktopToken(oriId: string, ttlSeconds = DESKTOP_TOKEN_TTL_SECONDS, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ oriId, exp } satisfies DesktopTokenPayload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export type DesktopTokenResult =
  | { ok: true; payload: DesktopTokenPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_ori" };

/**
 * Validate a token and confirm it is for `expectOriId`. Order matters: the signature is
 * checked before anything in the payload is trusted, because the payload is attacker-supplied
 * until proven otherwise.
 */
export function verifyDesktopToken(token: string, expectOriId: string, now = Date.now()): DesktopTokenResult {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  let payload: DesktopTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as DesktopTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.oriId !== "string" || typeof payload.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp * 1000 <= now) return { ok: false, reason: "expired" };
  if (payload.oriId !== expectOriId) return { ok: false, reason: "wrong_ori" };
  return { ok: true, payload };
}
