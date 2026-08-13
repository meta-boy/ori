import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@ori/contract";

/**
 * Dashboard session tokens.
 *
 * Same shape as the desktop token, for the same reasons: HMAC-signed and self-describing so the
 * common case needs no database round trip, but always checked against a row so that signing out
 * and revoking are real rather than cryptographic theatre. See docs/OPERATIONS.md — the signing
 * secret is the same deployment secret everything else derives from.
 *
 * A session is NOT an API key. Keys are for SDKs and the CLI and travel in an Authorization
 * header; sessions exist only so a browser does not have to hold a long-lived key in
 * localStorage, where any XSS would read it.
 */

/** How long a login lasts before it has to be repeated. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

/** The cookie the dashboard authenticates with. */
export const SESSION_COOKIE = "ori_session";

export interface SessionPayload {
  /** Session row id, so the token points at exactly one revocable record. */
  sid: string;
  userId: string;
  /** Unix seconds. */
  exp: number;
}

function secret(): string {
  const s = process.env.ORI_SNAPSHOT_SECRET;
  if (!s) throw new Error("ORI_SNAPSHOT_SECRET is not set; cannot sign sessions");
  return s;
}

function sign(body: string): string {
  // Domain-separated from desktop tokens and ori tokens: a signature minted for one purpose
  // must never validate for another.
  return createHmac("sha256", secret()).update(`session:${body}`).digest("base64url");
}

export function sessionId(): string {
  return `ses_${randomBytes(16).toString("hex")}`;
}

/** Mint a token for one session row. */
export function mintSessionToken(
  sid: string,
  userId: string,
  ttlSeconds = SESSION_TTL_SECONDS,
  now = Date.now(),
): { token: string; expiresAt: Date } {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ sid, userId, exp } satisfies SessionPayload)).toString("base64url");
  return { token: `${body}.${sign(body)}`, expiresAt: new Date(exp * 1000) };
}

export type SessionVerdict =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Validate a token's signature and expiry. Says nothing about whether the session still exists —
 * that is a database question, and the caller MUST ask it. The signature is checked before any
 * field of the payload is trusted, because the payload is attacker-supplied until proven
 * otherwise.
 */
export function verifySessionToken(token: string, now = Date.now()): SessionVerdict {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.sid !== "string" || typeof payload.userId !== "string" || typeof payload.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/** What goes in the database. The token itself is never stored. */
export function sessionTokenHash(token: string): string {
  return sha256Hex(token);
}

/**
 * The Set-Cookie value for a session.
 *
 * - HttpOnly, so no script can read it. This is the entire reason to prefer a cookie over
 *   keeping an API key in localStorage.
 * - SameSite=Strict is the CSRF defence: the cookie is simply not attached to requests
 *   originating from another site, so a hostile page cannot make authenticated calls.
 * - Secure only over https, or the cookie would be unusable on the http://localhost the
 *   dashboard is developed against.
 * - Path=/ because both /api/ori/v1 and /dashboard need it.
 */
export function sessionCookie(token: string, expiresAt: Date, isHttps: boolean): string {
  const maxAge = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    isHttps ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** The Set-Cookie value that clears a session. */
export function clearSessionCookie(isHttps: boolean): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Strict", isHttps ? "Secure" : ""]
    .filter(Boolean)
    .join("; ");
}

/** Pull one cookie out of a Cookie header without pulling in a parser. */
export function readCookie(header: string | undefined | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
