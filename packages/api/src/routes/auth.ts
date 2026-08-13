import type { Hono } from "hono";
import { and, eq, isNull, sql } from "drizzle-orm";
import { fail, ok, sha256Hex } from "@ori/contract";
import { invites, sessions, users } from "../db/schema";
import type { AppDeps, AppEnv } from "../context";
import {
  SESSION_TTL_SECONDS,
  SESSION_COOKIE,
  clearSessionCookie,
  mintSessionToken,
  readCookie,
  sessionCookie,
  sessionId,
  sessionTokenHash,
  verifySessionToken,
} from "../auth/session";
import { hashPassword, validatePassword, verifyPassword } from "../auth/passwords";

/**
 * Dashboard authentication: /auth/signup, /auth/login, /auth/logout, /auth/session.
 *
 * Mounted OUTSIDE /api/ori/v1 and outside the bearer middleware, because a login request by
 * definition arrives without credentials. It is also deliberately not part of the documented
 * surface — the v1 spec has no auth endpoints at all (its dashboard uses GitHub OAuth), so these are
 * declared in docs/DIVERGENCES.md.
 *
 * Sign-up is invite-only, and that is a security decision rather than a product one: this
 * control plane is meant to be reachable through a tunnel, and every account that exists can
 * spawn containers on the host. Open registration would let anyone who learns the URL farm the
 * machine.
 */

const AUTH_PREFIX = "/auth";

/** Rate limit login attempts per email, in memory. Cheap brake on credential stuffing. */
const attempts = new Map<string, { count: number; first: number }>();
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function tooManyAttempts(key: string, now: number): boolean {
  const rec = attempts.get(key);
  if (!rec || now - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

function clearAttempts(key: string): void {
  attempts.delete(key);
}

/** Normalise an email for comparison and storage. */
function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  // Deliberately permissive: the only property that matters here is that it is a single
  // address-shaped string we can compare. Real deliverability is not this system's problem.
  if (e.length < 3 || e.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

/** A login handle derived from an email, for the `login` the rest of the API already returns. */
function loginFromEmail(email: string): string {
  const base = email.split("@")[0]!.replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "user";
  return `${base}_${Math.random().toString(36).slice(2, 8)}`;
}

function isHttps(url: string, forwardedProto: string | undefined): boolean {
  // Behind a tunnel the connection to us is plain http, so trust the proxy's header when
  // present — that is what decides whether the cookie can be marked Secure.
  if (forwardedProto) return forwardedProto.split(",")[0]!.trim() === "https";
  return new URL(url).protocol === "https:";
}

export function registerAuthRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const now = () => (deps.now ?? (() => new Date()))();

  /** Create an account against a single-use invite. */
  app.post(`${AUTH_PREFIX}/signup`, async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw === null || typeof raw !== "object") return c.json(fail(400, "invalid_json"), 400);
    const body = raw as Record<string, unknown>;

    const email = normalizeEmail(body.email);
    if (!email) return c.json(fail(400, "invalid_json", "A valid email is required."), 400);

    const pw = validatePassword(body.password);
    if (!pw.ok) return c.json(fail(400, "invalid_json", pw.message), 400);

    const inviteToken = typeof body.invite === "string" ? body.invite.trim() : "";
    if (!inviteToken) {
      return c.json(fail(403, "forbidden", "An invite is required to sign up."), 403);
    }

    const invite = await deps.db.query.invites.findFirst({
      where: and(eq(invites.tokenHash, sha256Hex(inviteToken)), isNull(invites.usedAt)),
    });
    const at = now();
    if (!invite || (invite.expiresAt && invite.expiresAt.getTime() <= at.getTime())) {
      // One message for unknown, used and expired alike: distinguishing them would turn this
      // into an oracle for which invite tokens exist.
      return c.json(fail(403, "forbidden", "That invite is not valid."), 403);
    }

    const existing = await deps.db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) {
      return c.json(fail(400, "invalid_json", "That email is already registered."), 400);
    }

    const userId = `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const passwordHash = await hashPassword(body.password as string);

    /*
     * One transaction for "create the user AND spend the invite", because the two are only
     * correct together:
     *
     *   - invites.used_by_user_id is a foreign key to users.id, so the invite cannot be redeemed
     *     before the user row exists.
     *   - but if the user is inserted first and the redemption then loses a race, the account
     *     exists without having cost an invite — which is precisely the hole invite-only is
     *     supposed to close.
     *
     * The UPDATE still carries `isNull(usedAt)` in its WHERE, so two concurrent sign-ups
     * against one invite means exactly one of them updates a row and the other rolls back.
     */
    let created = false;
    try {
      await deps.db.transaction(async (tx) => {
        await tx.insert(users).values({
          id: userId,
          login: loginFromEmail(email),
          email,
          passwordHash,
          createdAt: at,
        });
        const redeemed = await tx
          .update(invites)
          .set({ usedAt: at, usedByUserId: userId })
          .where(and(eq(invites.id, invite.id), isNull(invites.usedAt)))
          .returning({ id: invites.id });
        if (redeemed.length === 0) throw new Error("invite already spent");
        created = true;
      });
    } catch {
      if (!created) return c.json(fail(403, "forbidden", "That invite is not valid."), 403);
    }

    const { expiresAt, cookie } = await openSession(deps, userId, c.req.header("user-agent"), c.req.url, c.req.header("x-forwarded-proto"), at);
    c.header("set-cookie", cookie);
    return c.json(ok("auth.session", { userId, email, expiresAt: expiresAt.toISOString() }), 201);
  });

  /** Exchange an email and password for a session cookie. */
  app.post(`${AUTH_PREFIX}/login`, async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw === null || typeof raw !== "object") return c.json(fail(400, "invalid_json"), 400);
    const body = raw as Record<string, unknown>;

    const email = normalizeEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const at = now();

    if (tooManyAttempts(email ?? "invalid", at.getTime())) {
      return c.json(fail(429, "rate_limited", "Too many sign-in attempts. Try again later."), 429);
    }

    // Look the user up even when the email is malformed, and always run a verify: an early
    // return here is what turns response time into an account-enumeration oracle.
    const user = email ? await deps.db.query.users.findFirst({ where: eq(users.email, email) }) : undefined;
    const good = await verifyPassword(password, user?.passwordHash ?? null);
    if (!user || !good) {
      return c.json(fail(401, "unauthorized", "Wrong email or password."), 401);
    }

    clearAttempts(email!);
    const { expiresAt, cookie } = await openSession(deps, user.id, c.req.header("user-agent"), c.req.url, c.req.header("x-forwarded-proto"), at);
    c.header("set-cookie", cookie);
    return c.json(ok("auth.session", { userId: user.id, email: user.email, expiresAt: expiresAt.toISOString() }));
  });

  /** End this session. Revokes the row, so the cookie is dead even if it is replayed. */
  app.post(`${AUTH_PREFIX}/logout`, async (c) => {
    const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
    if (token) {
      const verdict = verifySessionToken(token, now().getTime());
      if (verdict.ok) {
        await deps.db
          .update(sessions)
          .set({ revokedAt: now() })
          .where(eq(sessions.id, verdict.payload.sid));
      }
    }
    c.header("set-cookie", clearSessionCookie(isHttps(c.req.url, c.req.header("x-forwarded-proto"))));
    return c.json(ok("auth.logout", { success: true }));
  });

  /** Who am I, according to the cookie? Used by the dashboard to decide what to render. */
  app.get(`${AUTH_PREFIX}/session`, async (c) => {
    const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
    if (!token) return c.json(fail(401, "unauthorized"), 401);
    const resolved = await resolveSession(deps, token, now());
    if (!resolved) return c.json(fail(401, "unauthorized"), 401);
    return c.json(
      ok("auth.session", {
        userId: resolved.user.id,
        login: resolved.user.login,
        email: resolved.user.email,
        expiresAt: resolved.session.expiresAt.toISOString(),
      }),
    );
  });
}

async function openSession(
  deps: AppDeps,
  userId: string,
  userAgent: string | undefined,
  url: string,
  forwardedProto: string | undefined,
  at: Date,
): Promise<{ token: string; expiresAt: Date; cookie: string }> {
  const sid = sessionId();
  const { token, expiresAt } = mintSessionToken(sid, userId, SESSION_TTL_SECONDS, at.getTime());
  await deps.db.insert(sessions).values({
    id: sid,
    userId,
    tokenHash: sessionTokenHash(token),
    createdAt: at,
    expiresAt,
    userAgent: userAgent?.slice(0, 300) ?? null,
  });
  return { token, expiresAt, cookie: sessionCookie(token, expiresAt, isHttps(url, forwardedProto)) };
}

/**
 * Turn a session token into a user, or null.
 *
 * The signature is checked first, then the row — and the row check is what makes logout real. A
 * token whose signature is still perfect must stop working the moment its session is revoked.
 * The stored hash is compared too, so a token minted for a different session id cannot be
 * pointed at this row.
 */
export async function resolveSession(
  deps: AppDeps,
  token: string,
  at: Date,
): Promise<{ user: typeof users.$inferSelect; session: typeof sessions.$inferSelect } | null> {
  const verdict = verifySessionToken(token, at.getTime());
  if (!verdict.ok) return null;

  const session = await deps.db.query.sessions.findFirst({ where: eq(sessions.id, verdict.payload.sid) });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= at.getTime()) return null;
  if (session.tokenHash !== sessionTokenHash(token)) return null;
  if (session.userId !== verdict.payload.userId) return null;

  const user = await deps.db.query.users.findFirst({ where: eq(users.id, session.userId) });
  if (!user) return null;
  return { user, session };
}

/** Sweep expired and revoked sessions. Called from the reaper so rows do not accumulate. */
export async function pruneSessions(deps: AppDeps, at: Date): Promise<number> {
  const res = await deps.db
    .delete(sessions)
    .where(sql`${sessions.expiresAt} < ${at.toISOString()} or ${sessions.revokedAt} is not null`)
    .returning({ id: sessions.id });
  return res.length;
}
