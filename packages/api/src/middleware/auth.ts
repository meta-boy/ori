import type { MiddlewareHandler } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeySecretRegex, fail, sha256Hex } from "@ori/contract";
import { apiKeys, users } from "../db/schema";
import type { AppDeps, AppEnv } from "../context";
import { SESSION_COOKIE, readCookie } from "../auth/session";
import { resolveSession } from "../routes/auth";

// Re-export the crypto helpers so existing importers of "@ori/api/middleware/auth"
// keep working; their canonical home is @ori/contract so the guest agent can use
// them without depending on the control plane.
export { sha256Hex, timingSafeEqualHex } from "@ori/contract";

/**
 * How stale `api_keys.last_used_at` is allowed to get before a request rewrites it.
 *
 * The column answers "when was this key last used", which nothing needs to the second, and a
 * polling dashboard would otherwise turn every read into a row update plus a WAL record.
 */
const LAST_USED_GRANULARITY_MS = 60_000;

function unauthorized(c: { get: <K extends keyof AppEnv["Variables"]>(k: K) => AppEnv["Variables"][K] }) {
  const body = fail(401, "unauthorized") as { ok: false; requestId: string };
  body.requestId = c.get("requestId");
  return Response.json(body, { status: 401, headers: { "x-request-id": c.get("requestId") } });
}

/**
 * Bearer auth over sha256-hashed API keys. Rejects revoked keys and updates
 * `last_used_at` on each successful request.
 */
export function authMiddleware(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];

    /*
     * A browser session is accepted as an ALTERNATIVE to a bearer key, and only when no
     * Authorization header was sent. Order matters: bearer stays the documented path so a client
     * generated from the spec behaves identically, and a request that presents a key is judged on
     * that key alone rather than silently falling back to whatever cookie the browser attached.
     *
     * CSRF is handled by the cookie itself being SameSite=Strict, so it is never attached to a
     * request originating from another site. See auth/session.ts.
     */
    if (!token) {
      const cookie = readCookie(c.req.header("cookie"), SESSION_COOKIE);
      if (cookie) {
        const now = (deps.now ?? (() => new Date()))();
        const resolved = await resolveSession(deps, cookie, now);
        if (!resolved) return unauthorized(c);
        c.set("userId", resolved.user.id);
        c.set("login", resolved.user.login);
        c.set("email", resolved.user.email);
        c.set("authKind", "session");
        await next();
        return;
      }
    }

    if (!token || !apiKeySecretRegex.test(token)) {
      return unauthorized(c);
    }

    const hash = sha256Hex(token);
    const key = await deps.db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.hash, hash), isNull(apiKeys.revokedAt)),
    });
    if (!key) {
      return unauthorized(c);
    }

    const user = await deps.db.query.users.findFirst({
      where: eq(users.id, key.userId),
    });
    if (!user) {
      return unauthorized(c);
    }

    c.set("userId", user.id);
    c.set("login", user.login);
    c.set("email", user.email);
    c.set("authKind", "key");

    const now = (deps.now ?? (() => new Date()))();
    // A busy key would otherwise rewrite last_used_at on every request — each one a full row
    // update with its own round trip. Minute granularity is plenty for "when was this used";
    // a key used once an hour still records, because the write only skips inside the window.
    if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() >= LAST_USED_GRANULARITY_MS) {
      await deps.db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, key.id));
    }

    await next();
  };
}