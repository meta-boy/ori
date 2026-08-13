import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildDeps, seedUserKey, deleteOriCascade, type AppDeps } from "./helpers";
import { oris } from "@ori/api/db/schema";
import { oriId } from "@ori/contract";
import {
  DESKTOP_TOKEN_TTL_SECONDS,
  mintDesktopToken,
  verifyDesktopToken,
} from "@ori/api/desktop/token";
import { authorizeDesktopRequest, desktopViewerUrl, websocketPath } from "@ori/api/desktop/proxy";

// T-P8. x11vnc inside a ori runs with NO password and noVNC serves whoever asks, so the token
// plus the loopback-only publish IS the entire security model for a desktop. These tests are
// about that boundary, not about pixels.
process.env.ORI_SNAPSHOT_SECRET ??= "desktop-test-secret";

const deps: AppDeps = buildDeps();
const db = deps.db;
let user: Awaited<ReturnType<typeof seedUserKey>>;
const created: string[] = [];

async function seedOri(over: Partial<typeof oris.$inferInsert> = {}): Promise<string> {
  const id = oriId();
  await db.insert(oris).values({
    id,
    userId: user.userId,
    name: `ori ${id}`,
    state: "ready",
    type: "default",
    machineId: `m_${id}`,
    ip: "127.0.0.1:1",
    ttlSeconds: 3600,
    ...over,
  });
  created.push(id);
  return id;
}

beforeAll(async () => {
  user = await seedUserKey(db);
});
afterAll(async () => {
  for (const id of created.splice(0)) await deleteOriCascade(db, id);
});

describe("T-P8 desktop tokens", () => {
  test("a fresh token verifies for its own ori", () => {
    const id = oriId();
    const t = mintDesktopToken(id);
    const v = verifyDesktopToken(t, id);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.payload.oriId).toBe(id);
  });

  test("a token for ori A is USELESS against ori B", () => {
    // The property that stops a shared desktop link becoming a key to the whole fleet.
    const a = oriId();
    const b = oriId();
    const t = mintDesktopToken(a);
    const v = verifyDesktopToken(t, b);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("wrong_ori");
  });

  test("an expired token is refused, and the expiry cannot be edited", () => {
    const id = oriId();
    // Mint in the past.
    const t = mintDesktopToken(id, 1, Date.now() - 10_000);
    expect(verifyDesktopToken(t, id).ok).toBe(false);

    // Tamper with the payload to extend it: the signature must fail, not the expiry check.
    const fresh = mintDesktopToken(id, 60);
    const [body, mac] = fresh.split(".");
    const decoded = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    decoded.exp += 86_400;
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${mac}`;
    const v = verifyDesktopToken(forged, id);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("bad_signature");
  });

  test("garbage is refused without throwing", () => {
    for (const junk of ["", ".", "abc", "a.b", "....", "x".repeat(500)]) {
      expect(verifyDesktopToken(junk, oriId()).ok).toBe(false);
    }
  });

  test("the ttl is an hour at most", () => {
    expect(DESKTOP_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(3600);
  });
});

/** A request URL, with the token in the query only when one is given. Shared by every block. */
const u = (path: string, token?: string) =>
  new URL(`http://localhost:8787${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`);

/**
 * deps whose driver can actually publish a desktop.
 *
 * The fake driver has no desktopAddress, so authorization stops at 501 before it produces the
 * things a working desktop needs — `rest` and the cookie. That is fine for the blocks above,
 * which only care that a request was refused or not, but tests about a SERVING desktop have to
 * get past it. authorizeDesktopRequest touches only deps.db and deps.driver.desktopAddress.
 */
const servingDeps = {
  ...deps,
  driver: { desktopAddress: async () => ({ host: "127.0.0.1", port: 6080 }) },
} as unknown as AppDeps;

/** Mint a token and record it on the ori, the state a real POST /desktop leaves behind. */
async function liveToken(id: string): Promise<string> {
  const token = mintDesktopToken(id);
  await db
    .update(oris)
    .set({ desktopToken: token, desktopExpiresAt: new Date(Date.now() + 60_000) })
    .where(eq(oris.id, id));
  return token;
}

describe("T-P8 the proxy is the access control", () => {

  test("no token is 401", async () => {
    const id = await seedOri();
    const d = await authorizeDesktopRequest(deps, u(`/desktop/${id}/vnc.html`));
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
  });

  test("a valid signature is NOT enough — the row must still hold the token", async () => {
    // This is what makes revocation real. stop() clears desktop_token, and a token that is
    // still cryptographically perfect has to stop working the moment the ori is archived.
    const id = await seedOri();
    const t = mintDesktopToken(id);
    const before = await authorizeDesktopRequest(deps, u(`/desktop/${id}/vnc.html`, t));
    expect(before.ok).toBe(false); // the row has no token yet
    expect(before.status).toBe(401);

    await db.update(oris).set({ desktopToken: t, desktopExpiresAt: new Date(Date.now() + 60_000) }).where(eq(oris.id, id));
    const after = await authorizeDesktopRequest(deps, u(`/desktop/${id}/vnc.html`, t));
    // The fake driver has no desktopAddress, so it stops at 501 rather than 401 — which is
    // exactly the point: authorisation passed, only the driver cannot serve a desktop.
    expect(after.status).not.toBe(401);
  });

  test("clearing the row's token revokes access immediately", async () => {
    const id = await seedOri();
    const t = mintDesktopToken(id);
    await db.update(oris).set({ desktopToken: t, desktopExpiresAt: new Date(Date.now() + 60_000) }).where(eq(oris.id, id));
    await db.update(oris).set({ desktopToken: null }).where(eq(oris.id, id));
    const d = await authorizeDesktopRequest(deps, u(`/desktop/${id}/vnc.html`, t));
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
  });

  test("an expired row expiry revokes access even with a valid signature", async () => {
    const id = await seedOri();
    const t = mintDesktopToken(id, 3600);
    await db.update(oris).set({ desktopToken: t, desktopExpiresAt: new Date(Date.now() - 1000) }).where(eq(oris.id, id));
    const d = await authorizeDesktopRequest(deps, u(`/desktop/${id}/vnc.html`, t));
    expect(d.status).toBe(401);
  });

  test("ori A's token cannot reach ori B's desktop path", async () => {
    const a = await seedOri();
    const b = await seedOri();
    const t = mintDesktopToken(a);
    await db.update(oris).set({ desktopToken: t, desktopExpiresAt: new Date(Date.now() + 60_000) }).where(eq(oris.id, b));
    // Even with B's row holding A's token string, the signature binds it to A.
    const d = await authorizeDesktopRequest(deps, u(`/desktop/${b}/vnc.html`, t));
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
  });

  test("every failure says the same thing", async () => {
    // Distinguishing "expired" from "wrong ori" from "no such ori" would turn this into an
    // oracle for which ori ids exist.
    const id = await seedOri();
    const messages = new Set<string>();
    for (const tok of [mintDesktopToken(oriId()), mintDesktopToken(id, 1, Date.now() - 5000), "garbage"]) {
      const d = await authorizeDesktopRequest(deps, u(`/desktop/${id}/vnc.html`, tok));
      if (d.status === 401) messages.add(d.message ?? "");
    }
    expect(messages.size).toBe(1);
  });

  test("the websocket path is gated too, not just the html", async () => {
    // The websocket carries the screen and the keystrokes; gating only the page would be
    // security theatre.
    const id = await seedOri();
    const d = await authorizeDesktopRequest(deps, u(`/desktop/${id}/websockify`));
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
  });

  test("a non-desktop path is not handled here", async () => {
    const d = await authorizeDesktopRequest(deps, u("/api/ori/v1/oris"));
    expect(d.ok).toBe(false);
    expect(d.status).toBe(404);
  });
});

describe("T-P8 the URL we hand out is one the proxy actually serves", () => {
  // Everything above asserts authorisation DECISIONS, and all of it passed while the desktop
  // was unusable in a browser: the token authenticated the HTML document and nothing else, and
  // the viewer then opened a websocket at a path the proxy does not serve. A desktop that
  // authorises perfectly and renders nothing satisfied the whole suite. These tests are about
  // the URL being usable.

  test("the viewer URL carries a path pointing at THIS ori's websockify", async () => {
    const id = await seedOri();
    const url = new URL(desktopViewerUrl("http://localhost:8787", id, mintDesktopToken(id)));
    // Without this param noVNC connects to ws://host/websockify — the origin root, not
    // relative to the page — and dies with code 1006.
    expect(url.searchParams.get("path")).toBe(`desktop/${id}/websockify`);
    expect(url.searchParams.get("autoconnect")).toBe("true");
  });

  test("the websocket URL noVNC will build from it is one the proxy authorises", async () => {
    // The actual invariant, end to end: take the URL we hand a user, assemble the socket URL
    // the way noVNC does (origin + '/' + path), and confirm the proxy accepts it. If either
    // side moves independently, this fails.
    const id = await seedOri();
    const token = await liveToken(id);

    const viewer = new URL(desktopViewerUrl("http://localhost:8787", id, token));
    const wsUrl = new URL(`${viewer.origin}/${viewer.searchParams.get("path")}`);
    // The browser sends the cookie, not the query token, on that socket.
    const headers = new Headers({ cookie: `ori_desktop_${id}=${token}` });
    const d = await authorizeDesktopRequest(servingDeps, wsUrl, headers);
    expect(d.status).not.toBe(401);
    expect(d.status).not.toBe(404);
    expect(d.rest).toBe("websockify");
  });

  test("websocketPath has no leading slash, because noVNC adds one", () => {
    // noVNC does `url += '/' + path`. A leading slash here yields ws://host//desktop/... which
    // does not match the proxy prefix.
    expect(websocketPath("or_23456789").startsWith("/")).toBe(false);
    expect(`http://h/${websocketPath("or_23456789")}`).toBe("http://h/desktop/or_23456789/websockify");
  });
});

describe("T-P8 noVNC's own assets can authenticate", () => {
  // noVNC asks for 37 assets with RELATIVE urls, which do not inherit a query string. So the
  // query token authenticated the document and every asset 401'd — the page rendered as
  // unstyled text with broken images. The document now sets a cookie.

  test("the authorised document is handed a cookie scoped to just this ori", async () => {
    const id = await seedOri();
    const token = await liveToken(id);
    const d = await authorizeDesktopRequest(servingDeps, u(`/desktop/${id}/vnc.html`, token));
    expect(d.setCookie).toBeTruthy();
    expect(d.setCookie).toContain(`ori_desktop_${id}=${token}`);
    expect(d.setCookie).toContain(`Path=/desktop/${id}/`); // never sent to the API or another ori
    expect(d.setCookie).toContain("HttpOnly");
    expect(d.setCookie).toContain("SameSite=Lax");
  });

  test("an asset request with only the cookie is authorised", async () => {
    const id = await seedOri();
    const token = await liveToken(id);
    const headers = new Headers({ cookie: `other=1; ori_desktop_${id}=${token}; x=2` });
    const d = await authorizeDesktopRequest(servingDeps, u(`/desktop/${id}/app/ui.js`), headers);
    expect(d.status).not.toBe(401);
    expect(d.rest).toBe("app/ui.js");
  });

  test("an asset request with neither cookie nor token is still refused", async () => {
    const id = await seedOri();
    const d = await authorizeDesktopRequest(deps, u(`/desktop/${id}/app/ui.js`));
    expect(d.status).toBe(401);
  });

  test("ori A's cookie does not open ori B, even though the name differs", async () => {
    // The cookie is a delivery mechanism, not a weaker credential: the token inside is still
    // verified against the ori in the path.
    const a = await seedOri();
    const b = await seedOri();
    const tokenA = mintDesktopToken(a);
    await db
      .update(oris)
      .set({ desktopToken: tokenA, desktopExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(oris.id, b));
    const headers = new Headers({ cookie: `ori_desktop_${b}=${tokenA}` });
    const d = await authorizeDesktopRequest(deps, u(`/desktop/${b}/app/ui.js`), headers);
    expect(d.status).toBe(401);
  });

  test("a cookie-authenticated request does not re-issue the cookie", async () => {
    const id = await seedOri();
    const token = await liveToken(id);
    const headers = new Headers({ cookie: `ori_desktop_${id}=${token}` });
    const d = await authorizeDesktopRequest(servingDeps, u(`/desktop/${id}/app/ui.js`), headers);
    expect(d.setCookie).toBeUndefined();
  });

  test("an expired token in a cookie is refused like any other", async () => {
    const id = await seedOri();
    const stale = mintDesktopToken(id, 1, Date.now() - 10_000);
    await db
      .update(oris)
      .set({ desktopToken: stale, desktopExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(oris.id, id));
    const headers = new Headers({ cookie: `ori_desktop_${id}=${stale}` });
    const d = await authorizeDesktopRequest(deps, u(`/desktop/${id}/app/ui.js`), headers);
    expect(d.status).toBe(401);
  });
});
