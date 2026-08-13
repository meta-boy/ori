import { eq } from "drizzle-orm";
import { oris } from "../db/schema";
import type { AppDeps } from "../context";
import { verifyDesktopToken } from "./token";

/**
 * The authenticating desktop proxy.
 *
 * Everything about desktop security lives here. x11vnc runs with no password, noVNC serves
 * whoever asks, and the ori's 6080 is published on loopback so only this process can reach it.
 * So this proxy IS the access control: without it the /desktop endpoint would be decoration.
 *
 * It handles two kinds of traffic on /desktop/:oriId/*
 *   - plain HTTP for noVNC's html/js/css
 *   - a WebSocket upgrade for the VNC stream itself
 * and validates the signed token on both. Validating only the first would be useless: the
 * websocket carries the actual screen and keystrokes.
 */

const PREFIX = "/desktop/";

/**
 * The path this proxy serves a ori's VNC websocket on, WITHOUT a leading slash — noVNC adds
 * one when it assembles `ws://host:port/` + path.
 *
 * Exported so the viewer URL and the proxy's own routing come from one place. They were
 * independent, and noVNC does not build its socket URL relative to the page: it uses the
 * origin plus its `path` setting, which defaults to plain "websockify". So the browser opened
 * ws://host/websockify, nothing served it, and the viewer failed with "Connection closed
 * (code: 1006)" on a page that had otherwise loaded perfectly.
 */
export function websocketPath(oriId: string): string {
  return `${PREFIX.slice(1)}${oriId}/websockify`;
}

/**
 * The URL a browser opens to see a ori's desktop.
 *
 * `path` is load-bearing (see websocketPath). `autoconnect` skips the connect button, and
 * `resize=scale` fits the remote screen to the window.
 */
export function desktopViewerUrl(base: string, oriId: string, token: string): string {
  const q = new URLSearchParams({
    token,
    path: websocketPath(oriId),
    autoconnect: "true",
    resize: "scale",
  });
  return `${base}${PREFIX}${oriId}/vnc.html?${q.toString()}`;
}

export interface DesktopProxyTarget {
  host: string;
  port: number;
}

/** Drivers that can publish a desktop expose this; others simply have no desktop. */
interface MaybeDesktopDriver {
  desktopAddress?: (machineId: string) => Promise<DesktopProxyTarget | null>;
}

export interface ProxyDecision {
  ok: boolean;
  status?: number;
  message?: string;
  oriId?: string;
  /** Path inside noVNC, e.g. "vnc.html" or "websockify". */
  rest?: string;
  target?: DesktopProxyTarget;
  /**
   * A Set-Cookie value the caller must put on the response, present when this request
   * authenticated by query token. See cookieFor() for why.
   */
  setCookie?: string;
}

/**
 * Per-ori cookie name. noVNC asks for its assets with RELATIVE urls — `app/styles/base.css`,
 * `app/images/drag.png`, `app/ui.js` — and a relative url does not inherit the query string.
 * So the token in the desktop URL authenticates the HTML document and NOTHING else: every
 * asset arrived without it, got a 401, and the page rendered as unstyled text with broken
 * images and "noVNC encountered an error".
 *
 * Handing the document a cookie fixes it for every subsequent request, including the
 * websocket. Scoped per ori so two desktops open in one browser cannot clobber each other's
 * token — the name carries the ori id, and ori ids are already cookie-name safe.
 */
function cookieName(oriId: string): string {
  return `ori_desktop_${oriId}`;
}

/** Read our cookie out of a Cookie header without pulling in a parser. */
function cookieToken(headers: Headers | undefined, oriId: string): string | null {
  const raw = headers?.get("cookie");
  if (!raw) return null;
  const want = cookieName(oriId);
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === want) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * The cookie that carries the token to noVNC's own asset requests.
 *
 * - Path is the ori's own desktop prefix, so it is never sent to the API or to another ori.
 * - HttpOnly: noVNC has no reason to read it, and it keeps the token out of any XSS reach.
 * - SameSite=Lax so a top-level navigation to the desktop link still works.
 * - Max-Age tracks the token's own expiry rather than being a session cookie, so a stale
 *   cookie cannot outlive the credential it carries.
 * - Secure only over https: setting it unconditionally would make the cookie unusable on the
 *   http://localhost URL the CLI hands out in dev.
 */
function cookieFor(oriId: string, token: string, url: URL, expiresAt: number): string {
  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${cookieName(oriId)}=${token}; Path=${PREFIX}${oriId}/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/**
 * Decide whether a request may reach a ori's desktop. Split out from the serving code so it is
 * testable without sockets — the interesting failures (wrong ori, expired, revoked) are all
 * decisions, not plumbing.
 */
export async function authorizeDesktopRequest(
  deps: AppDeps,
  url: URL,
  headers?: Headers,
): Promise<ProxyDecision> {
  if (!url.pathname.startsWith(PREFIX)) return { ok: false, status: 404, message: "not a desktop path" };
  const after = url.pathname.slice(PREFIX.length);
  const slash = after.indexOf("/");
  const oriId = slash === -1 ? after : after.slice(0, slash);
  const rest = slash === -1 ? "" : after.slice(slash + 1);
  if (!oriId) return { ok: false, status: 404, message: "no ori in path" };

  // Query first (the link the user opened), then the cookie that link left behind (every
  // relative asset request and the websocket). Both carry the same signed token, and it is
  // verified identically either way — the cookie is a delivery mechanism, not a second
  // credential with weaker checks.
  const fromQuery = url.searchParams.get("token");
  const token = fromQuery ?? cookieToken(headers, oriId);
  if (!token) return { ok: false, status: 401, message: "token required" };

  const verdict = verifyDesktopToken(token, oriId);
  if (!verdict.ok) {
    // One message for every failure mode. Telling a caller whether a token was expired or
    // simply for another ori turns this into an oracle about which oris exist.
    return { ok: false, status: 401, message: "invalid token" };
  }

  const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  if (!row) return { ok: false, status: 404, message: "no such ori" };

  // The signature alone is not enough: a stop revokes access by clearing the row's token, and
  // a token that is still cryptographically valid must stop working the moment the ori is
  // archived. Checking the DB copy is what makes revocation real.
  if (!row.desktopToken || row.desktopToken !== token) {
    return { ok: false, status: 401, message: "invalid token" };
  }
  if (row.desktopExpiresAt && row.desktopExpiresAt.getTime() <= Date.now()) {
    return { ok: false, status: 401, message: "invalid token" };
  }
  if (!row.machineId) return { ok: false, status: 409, message: "ori is not running" };

  const driver = deps.driver as MaybeDesktopDriver;
  if (typeof driver.desktopAddress !== "function") {
    return { ok: false, status: 501, message: "this driver has no desktop" };
  }
  const target = await driver.desktopAddress(row.machineId);
  if (!target) return { ok: false, status: 409, message: "desktop not published for this ori" };

  // Only mint a cookie when the token came from the URL: that is the one request that has a
  // token the browser is about to lose. Re-issuing it on every cookie-authenticated asset
  // would be pointless churn.
  const setCookie = fromQuery
    ? cookieFor(oriId, token, url, verdict.payload.exp * 1000)
    : undefined;

  return { ok: true, oriId, rest, target, setCookie };
}

/**
 * Install the proxy on a Bun server. Returns a fetch handler to try BEFORE the Hono app, and
 * the websocket handlers Bun needs. Kept separate from the Hono app because a WebSocket
 * upgrade needs `server.upgrade`, which only the raw Bun server can do.
 */
export function createDesktopProxy(deps: AppDeps) {
  return {
    /** Does this request belong to the proxy at all? */
    handles(url: URL): boolean {
      return url.pathname.startsWith(PREFIX);
    },

    /**
     * Handle an HTTP request or begin a websocket upgrade. Returns a Response, or undefined
     * when the upgrade was accepted (Bun then drives the socket handlers).
     */
    async fetch(req: Request, server: { upgrade: (r: Request, o?: unknown) => boolean }): Promise<Response | undefined> {
      const url = new URL(req.url);
      const decision = await authorizeDesktopRequest(deps, url, req.headers);
      if (!decision.ok) {
        return new Response(decision.message ?? "forbidden", { status: decision.status ?? 403 });
      }
      const { target, rest } = decision;

      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        // Hand the upstream address to the socket handlers; the client socket is opened only
        // after the token has already been accepted.
        const upstream = `ws://${target!.host}:${target!.port}/${rest}${url.search}`;
        if (server.upgrade(req, { data: { upstream } })) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }

      const upstreamUrl = `http://${target!.host}:${target!.port}/${rest}${url.search}`;
      try {
        const upstream = await fetch(upstreamUrl, {
          method: req.method,
          headers: stripHopHeaders(req.headers),
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        });
        const headers = stripHopHeaders(upstream.headers);
        // Hand the browser the token before it starts asking for assets it cannot attach a
        // query string to. Without this the document loads and everything it references 401s.
        if (decision.setCookie) headers.append("set-cookie", decision.setCookie);
        return new Response(upstream.body, { status: upstream.status, headers });
      } catch (e) {
        return new Response(`desktop unreachable: ${(e as Error).message}`, { status: 502 });
      }
    },

    /** Bun websocket handlers that pipe the browser socket to the ori's noVNC socket. */
    websocket: {
      open(ws: { data: { upstream: string; up?: WebSocket }; close: (c?: number, r?: string) => void; send: (d: string | Uint8Array) => void }) {
        const up = new WebSocket(ws.data.upstream);
        up.binaryType = "arraybuffer";
        ws.data.up = up;
        up.onmessage = (ev) => {
          ws.send(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
        };
        // Either side closing must close the other, or a browser tab left open holds an
        // x11vnc session inside the ori forever.
        up.onclose = () => ws.close(1000, "upstream closed");
        up.onerror = () => ws.close(1011, "upstream error");
      },
      message(ws: { data: { up?: WebSocket } }, message: string | Uint8Array) {
        const up = ws.data.up;
        if (up && up.readyState === WebSocket.OPEN) up.send(message as never);
      },
      close(ws: { data: { up?: WebSocket } }) {
        try {
          ws.data.up?.close();
        } catch {
          /* already closed */
        }
      },
    },
  };
}

/** Drop hop-by-hop headers; forwarding them corrupts a proxied connection. */
function stripHopHeaders(h: Headers): Headers {
  const out = new Headers();
  const drop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
  ]);
  h.forEach((v, k) => {
    if (!drop.has(k.toLowerCase())) out.set(k, v);
  });
  return out;
}
