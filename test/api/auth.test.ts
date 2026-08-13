import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { sha256Hex } from "@ori/contract";
import { buildApp, makeDb } from "./helpers";
import { invites, sessions, users, oris } from "@ori/api/db/schema";
import { oriId } from "@ori/contract";
import {
  SESSION_COOKIE,
  mintSessionToken,
  sessionCookie,
  sessionId,
  sessionTokenHash,
  verifySessionToken,
} from "@ori/api/auth/session";
import { verifyPassword, validatePassword, MIN_PASSWORD_LENGTH } from "@ori/api/auth/passwords";

/**
 * Auth is the one place where "it works" is not the interesting question. These tests are about
 * what must NOT work: enumerating accounts, reusing an invite, replaying a revoked session, or
 * reading another user's oris.
 */
process.env.ORI_SNAPSHOT_SECRET ??= "auth-test-secret";

const deps = { db: makeDb() };
const app = buildApp(deps);
const db = deps.db;
const madeUsers: string[] = [];
const madeInvites: string[] = [];

async function mintInvite(opts: { expiresAt?: Date } = {}): Promise<string> {
  const token = `inv_${randomBytes(12).toString("base64url")}`;
  const id = `invt_${randomBytes(6).toString("hex")}`;
  await db.insert(invites).values({ id, tokenHash: sha256Hex(token), expiresAt: opts.expiresAt ?? null });
  madeInvites.push(id);
  return token;
}

function email(): string {
  return `u${randomBytes(6).toString("hex")}@example.com`;
}

const PASSWORD = "correct horse battery staple";

async function signup(body: Record<string, unknown>) {
  const res = await app.request("/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
}

async function login(body: Record<string, unknown>) {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
}

/** The cookie value a browser would send back. */
function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0] ?? "";
}

afterAll(async () => {
  for (const id of madeUsers.splice(0)) {
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

describe("signup is invite-only", () => {
  test("no invite is refused", async () => {
    // The property that keeps a tunnel-exposed instance from becoming a container farm.
    const { res } = await signup({ email: email(), password: PASSWORD });
    expect(res.status).toBe(403);
  });

  test("a garbage invite is refused", async () => {
    const { res } = await signup({ email: email(), password: PASSWORD, invite: "inv_not-a-real-token" });
    expect(res.status).toBe(403);
  });

  test("a valid invite creates the account and returns a session cookie", async () => {
    const invite = await mintInvite();
    const e = email();
    const { res, json } = await signup({ email: e, password: PASSWORD, invite });
    expect(res.status).toBe(201);
    expect(json.ok).toBe(true);
    madeUsers.push(json.userId);

    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toContain(`${SESSION_COOKIE}=`);
    expect(set).toContain("HttpOnly"); // no script may read it — the reason to prefer a cookie
    expect(set).toContain("SameSite=Strict"); // the CSRF defence
  });

  test("an invite cannot be used twice", async () => {
    const invite = await mintInvite();
    const first = await signup({ email: email(), password: PASSWORD, invite });
    expect(first.res.status).toBe(201);
    madeUsers.push(first.json.userId);

    const second = await signup({ email: email(), password: PASSWORD, invite });
    expect(second.res.status).toBe(403);
  });

  test("an expired invite is refused", async () => {
    const invite = await mintInvite({ expiresAt: new Date(Date.now() - 1000) });
    const { res } = await signup({ email: email(), password: PASSWORD, invite });
    expect(res.status).toBe(403);
  });

  test("unknown, used and expired invites are indistinguishable", async () => {
    // Different messages here would be an oracle for which invite tokens exist.
    const used = await mintInvite();
    const ok1 = await signup({ email: email(), password: PASSWORD, invite: used });
    madeUsers.push(ok1.json.userId);
    const expired = await mintInvite({ expiresAt: new Date(Date.now() - 1000) });

    const messages = new Set<string>();
    for (const inv of ["inv_nope", used, expired]) {
      const { json } = await signup({ email: email(), password: PASSWORD, invite: inv });
      messages.add(json.message);
    }
    expect(messages.size).toBe(1);
  });

  test("a weak password is refused before the invite is spent", async () => {
    const invite = await mintInvite();
    const { res } = await signup({ email: email(), password: "short", invite });
    expect(res.status).toBe(400);
    // The invite must survive a rejected attempt, or a typo burns it.
    const row = await db.query.invites.findFirst({ where: eq(invites.tokenHash, sha256Hex(invite)) });
    expect(row?.usedAt ?? null).toBeNull();
  });

  test("a malformed email is refused", async () => {
    const invite = await mintInvite();
    for (const bad of ["", "nope", "a@b", "@example.com", "a b@example.com"]) {
      const { res } = await signup({ email: bad, password: PASSWORD, invite });
      expect(res.status, bad).toBe(400);
    }
  });
});

describe("login", () => {
  let e: string;
  let userId: string;

  beforeAll(async () => {
    const invite = await mintInvite();
    e = email();
    const { json } = await signup({ email: e, password: PASSWORD, invite });
    userId = json.userId;
    madeUsers.push(userId);
  });

  test("the right password works", async () => {
    const { res, json } = await login({ email: e, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(json.userId).toBe(userId);
  });

  test("the wrong password does not", async () => {
    const { res } = await login({ email: e, password: `${PASSWORD}x` });
    expect(res.status).toBe(401);
  });

  test("an unknown email and a wrong password say exactly the same thing", async () => {
    // Otherwise the response tells an attacker which emails are registered.
    const a = await login({ email: e, password: "definitely wrong" });
    const b = await login({ email: email(), password: "definitely wrong" });
    expect(a.res.status).toBe(b.res.status);
    expect(a.json.message).toBe(b.json.message);
    expect(a.json.code).toBe(b.json.code);
  });

  test("email is matched case-insensitively", async () => {
    const { res } = await login({ email: e.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
  });

  test("a service identity with no password cannot be logged into", async () => {
    // scripts/create-key.ts makes users with a null password_hash. A null must mean "cannot sign
    // in", never "any password works".
    const id = `usr_${randomBytes(8).toString("hex")}`;
    const svcEmail = email();
    await db.insert(users).values({ id, login: `svc_${id.slice(4, 10)}`, email: svcEmail });
    madeUsers.push(id);
    for (const pw of ["", " ", PASSWORD, "null", "undefined"]) {
      const { res } = await login({ email: svcEmail, password: pw });
      expect(res.status, pw).toBe(401);
    }
  });
});

describe("sessions", () => {
  let e: string;
  let userId: string;
  let cookie: string;

  beforeAll(async () => {
    const invite = await mintInvite();
    e = email();
    const { res, json } = await signup({ email: e, password: PASSWORD, invite });
    userId = json.userId;
    madeUsers.push(userId);
    cookie = cookieFrom(res);
  });

  test("the cookie authenticates the documented API, with no bearer key at all", async () => {
    const res = await app.request("/api/ori/v1/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.email).toBe(e);
  });

  test("no cookie and no key is still 401", async () => {
    const res = await app.request("/api/ori/v1/me");
    expect(res.status).toBe(401);
  });

  test("logout revokes the session, so the same cookie stops working", async () => {
    // The point of storing a row rather than trusting the signature alone.
    const invite = await mintInvite();
    const e2 = email();
    const s = await signup({ email: e2, password: PASSWORD, invite });
    madeUsers.push(s.json.userId);
    const c = cookieFrom(s.res);

    expect((await app.request("/api/ori/v1/me", { headers: { cookie: c } })).status).toBe(200);
    const out = await app.request("/auth/logout", { method: "POST", headers: { cookie: c } });
    expect(out.status).toBe(200);
    expect((await app.request("/api/ori/v1/me", { headers: { cookie: c } })).status).toBe(401);
  });

  test("a cryptographically perfect token for a session that does not exist is refused", async () => {
    // Forging the signature is not enough; the row has to be there.
    const { token } = mintSessionToken(sessionId(), userId);
    const res = await app.request("/api/ori/v1/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(401);
  });

  test("a tampered payload fails on the signature, not the lookup", async () => {
    const [body, mac] = cookie.replace(`${SESSION_COOKIE}=`, "").split(".");
    const decoded = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    decoded.exp += 86_400 * 365;
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${mac}`;
    expect(verifySessionToken(forged).ok).toBe(false);
    const res = await app.request("/api/ori/v1/me", { headers: { cookie: `${SESSION_COOKIE}=${forged}` } });
    expect(res.status).toBe(401);
  });

  test("a token whose stored hash does not match its row is refused", async () => {
    // Guards against pointing a freshly minted token at somebody else's session row.
    const sid = sessionId();
    await db.insert(sessions).values({
      id: sid,
      userId,
      tokenHash: sha256Hex("some other token"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { token } = mintSessionToken(sid, userId);
    const res = await app.request("/api/ori/v1/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(401);
  });

  test("an expired session row is refused even with a valid signature", async () => {
    const sid = sessionId();
    const { token } = mintSessionToken(sid, userId);
    await db.insert(sessions).values({
      id: sid,
      userId,
      tokenHash: sessionTokenHash(token),
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await app.request("/api/ori/v1/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(401);
  });

  test("garbage cookies are refused without throwing", async () => {
    for (const junk of ["", ".", "abc", "a.b", "....", "x".repeat(600)]) {
      const res = await app.request("/api/ori/v1/me", { headers: { cookie: `${SESSION_COOKIE}=${junk}` } });
      expect([401, 400].includes(res.status), junk).toBe(true);
    }
  });

  test("one user's session cannot see another user's oris", async () => {
    // The isolation the whole thing rests on.
    const inviteB = await mintInvite();
    const b = await signup({ email: email(), password: PASSWORD, invite: inviteB });
    madeUsers.push(b.json.userId);
    const cookieB = cookieFrom(b.res);

    const id = oriId();
    await db.insert(oris).values({
      id,
      userId,
      name: `ori ${id}`,
      state: "ready",
      type: "default",
      ttlSeconds: 3600,
    });
    try {
      const mine = await app.request(`/api/ori/v1/oris/${id}`, { headers: { cookie } });
      expect(mine.status).toBe(200);
      const theirs = await app.request(`/api/ori/v1/oris/${id}`, { headers: { cookie: cookieB } });
      expect(theirs.status).toBe(404); // not 403 — never confirm the id exists
    } finally {
      await db.delete(oris).where(eq(oris.id, id));
    }
  });

  test("a bearer key wins over a cookie, so a key request is judged on the key alone", async () => {
    // Order matters: a request that presents an Authorization header must not silently fall back
    // to whatever cookie the browser attached.
    const res = await app.request("/api/ori/v1/me", {
      headers: { cookie, authorization: "Bearer ori_live_totallyinvalidkeyvalue0000000000000000" },
    });
    expect(res.status).toBe(401);
  });
});

describe("session cookie flags", () => {
  test("Secure is set over https and omitted over http", () => {
    // Marking it Secure unconditionally would make the cookie unusable on the http://localhost
    // the dashboard is developed against; omitting it over https would leak the session.
    const exp = new Date(Date.now() + 60_000);
    expect(sessionCookie("t", exp, true)).toContain("Secure");
    expect(sessionCookie("t", exp, false)).not.toContain("Secure");
  });

  test("the cookie always carries HttpOnly and SameSite=Strict", () => {
    const c = sessionCookie("t", new Date(Date.now() + 60_000), false);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
  });
});

describe("password handling", () => {
  test("a short password is rejected", () => {
    expect(validatePassword("a".repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(false);
    expect(validatePassword("a".repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
  });

  test("an absurdly long password is rejected rather than hashed", () => {
    // argon2 is deliberately slow; letting a request choose how slow is a denial-of-service.
    expect(validatePassword("a".repeat(100_000)).ok).toBe(false);
  });

  test("verifying against a null hash is false, not a throw and not true", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
  });

  test("a corrupt stored hash is a failed login, not a 500", async () => {
    expect(await verifyPassword("anything", "not-an-argon2-hash")).toBe(false);
  });
});

describe("API keys can be created from the UI, but only with a session", () => {
  /**
   * The property this whole design rests on: a bearer key cannot mint another bearer key.
   *
   * If it could, a leaked key would be self-perpetuating -- revoking it achieves nothing once the
   * holder has minted replacements. Minting is therefore gated behind the password-backed
   * session, and these tests assert the gate rather than the happy path.
   */
  let cookie: string;
  let keyFromSession: string;

  beforeAll(async () => {
    const invite = await mintInvite();
    const res = await signup({ email: email(), password: PASSWORD, invite });
    madeUsers.push(res.json.userId);
    cookie = cookieFrom(res.res);
  });

  async function post(path: string, body: unknown, headers: Record<string, string>) {
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { res, json: await res.json().catch(() => null) };
  }

  test("a session can mint a key, and the secret is returned exactly once", async () => {
    const { res, json } = await post("/api/ori/v1/api-keys", { name: "laptop" }, { cookie });
    expect(res.status).toBe(201);
    expect(json.secret).toMatch(/^ori_live_/);
    keyFromSession = json.secret;

    // The list must never carry it again -- only a prefix and the last four.
    const list = await app.request("/api/ori/v1/api-keys", { headers: { cookie } });
    const body = await list.json();
    expect(JSON.stringify(body)).not.toContain(keyFromSession);
    expect(body.apiKeys[0].keyLastFour).toBe(keyFromSession.slice(-4));
  });

  test("the minted key actually works for the documented API", async () => {
    const res = await app.request("/api/ori/v1/me", { headers: { authorization: `Bearer ${keyFromSession}` } });
    expect(res.status).toBe(200);
  });

  test("a KEY cannot mint another key", async () => {
    // The whole point. 403, not 401: the caller is authenticated, just not permitted.
    const { res } = await post("/api/ori/v1/api-keys", { name: "escalation" }, { authorization: `Bearer ${keyFromSession}` });
    expect(res.status).toBe(403);
  });

  test("a KEY cannot revoke keys either", async () => {
    // Otherwise a leaked key can revoke the credentials you would use to lock it out.
    const list = await app.request("/api/ori/v1/api-keys", { headers: { cookie } });
    const id = (await list.json()).apiKeys[0].id;
    const res = await app.request(`/api/ori/v1/api-keys/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${keyFromSession}` },
    });
    expect(res.status).toBe(403);
  });

  test("an unnamed or over-long name is refused", async () => {
    for (const name of ["", "   ", "x".repeat(121)]) {
      const { res } = await post("/api/ori/v1/api-keys", { name }, { cookie });
      expect(res.status, JSON.stringify(name)).toBe(400);
    }
  });

  test("revoking with a session kills the key immediately", async () => {
    const made = await post("/api/ori/v1/api-keys", { name: "throwaway" }, { cookie });
    const secret = made.json.secret;
    const id = made.json.apiKey.id;
    expect((await app.request("/api/ori/v1/me", { headers: { authorization: `Bearer ${secret}` } })).status).toBe(200);

    const del = await app.request(`/api/ori/v1/api-keys/${id}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    expect((await app.request("/api/ori/v1/me", { headers: { authorization: `Bearer ${secret}` } })).status).toBe(401);
  });

  test("revoking twice is 404, and never touches another user's key", async () => {
    const made = await post("/api/ori/v1/api-keys", { name: "double" }, { cookie });
    const id = made.json.apiKey.id;
    expect((await app.request(`/api/ori/v1/api-keys/${id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect((await app.request(`/api/ori/v1/api-keys/${id}`, { method: "DELETE", headers: { cookie } })).status).toBe(404);

    // Another user's session must not be able to revoke it either.
    const invite2 = await mintInvite();
    const other = await signup({ email: email(), password: PASSWORD, invite: invite2 });
    madeUsers.push(other.json.userId);
    const otherMade = await post("/api/ori/v1/api-keys", { name: "theirs" }, { cookie: cookieFrom(other.res) });
    const res = await app.request(`/api/ori/v1/api-keys/${otherMade.json.apiKey.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(404); // not 403 -- never confirm the id exists
  });
});
