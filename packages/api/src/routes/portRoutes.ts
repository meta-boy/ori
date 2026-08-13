import type { Context, Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fail, ok, ACTIVE } from "@ori/contract";
import { oris, portRoutes } from "../db/schema";
import { BASE_PATH, EDGE_DOMAIN, type AppDeps, type AppEnv } from "../context";
import type { PortHostingDriver } from "../drivers/types";

/**
 * P12-07 — public hosting: `host <port>` inside a ori (or `ori host <id> <port>` on the
 * laptop) exposes a service on a stable HTTPS URL `https://<subdomain>-<port>.<EDGE_DOMAIN>`.
 *
 * The DB row (portRoutes) is the source of truth and survives stop/resume; the edge proxy
 * (Caddy) is reconciled through the RouteRegistrar, which is optional so tests and laptops
 * keep working without an edge. Gated routes carry a random `_token` (stored hashed? no —
 * the token is needed by /internal/edge/validate to compare, so it is stored in plaintext
 * in the row, exactly like the desktop token; it is random 32 bytes, scoped to one route).
 */

/** Cap per ori, matching the docs' 50-port limit. */
export const MAX_ROUTES_PER_ORI = 50;

export interface RouteRequest {
  port: number;
  title?: string;
  public?: boolean;
}

export interface HostedRoute {
  oriId: string;
  port: number;
  subdomain: string;
  hostname: string;
  url: string;
  access: "private" | "public";
  isProtected: boolean;
  title: string | null;
  token: string | null;
}

export function routeHostname(subdomain: string, port: number): string {
  return `${subdomain}-${port}.${EDGE_DOMAIN}`;
}

/**
 * The inverse of routeHostname. Both the subdomain AND the port identify a route — looking a
 * hostname up by port alone finds another ori's row as soon as two oris host the same port,
 * which is the common case (3000, 8080).
 */
function parseRouteHostname(hostname: string): { subdomain: string; port: number } | null {
  const suffix = `.${EDGE_DOMAIN}`;
  if (!hostname.endsWith(suffix)) return null;
  const m = /^(.+)-(\d+)$/.exec(hostname.slice(0, -suffix.length));
  return m ? { subdomain: m[1], port: Number(m[2]) } : null;
}

/** The route a public hostname resolves to, or null when nothing is registered for it. */
async function routeForHostname(deps: AppDeps, hostname: string) {
  const parsed = parseRouteHostname(hostname);
  if (!parsed) return null;
  return (
    (await deps.db.query.portRoutes.findFirst({
      where: and(eq(portRoutes.subdomain, parsed.subdomain), eq(portRoutes.port, parsed.port)),
    })) ?? null
  );
}

function mintRouteToken(): string {
  return randomBytes(32).toString("hex");
}

/** Dial target for the edge: the driver's host-side address for that container port. */
async function dialFor(deps: AppDeps, machineId: string | null, port: number): Promise<string | null> {
  if (!machineId) return null;
  const driver = deps.driver as unknown as PortHostingDriver;
  if (typeof driver.hostAddress !== "function") return null;
  const addr = await driver.hostAddress(machineId, port);
  return addr ? `${addr.host}:${addr.port}` : null;
}

/** Ensure the ori has a subdomain (auto-assign from its id on first route), returning it. */
export async function ensureSubdomain(deps: AppDeps, oriId: string): Promise<string> {
  const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  if (row?.subdomain) return row.subdomain;
  // `or_xxxxxxxx` is already a valid DNS label; drop the underscore for the hostname.
  const sub = `or${oriId.replace(/^or_/, "")}`;
  await deps.db.update(oris).set({ subdomain: sub, updatedAt: new Date() }).where(eq(oris.id, oriId));
  return sub;
}

/** Register (or re-register) one hosted port. Idempotent: same ori+port returns the same URL/token. */
export async function registerPortRoute(
  deps: AppDeps,
  ori: { id: string; machineId: string | null; state: string },
  req: RouteRequest,
): Promise<HostedRoute> {
  const port = req.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RouteError(400, "invalid_json", "port must be an integer 1-65535");
  }

  const existing = await deps.db.query.portRoutes.findFirst({
    where: and(eq(portRoutes.oriId, ori.id), eq(portRoutes.port, port)),
  });
  const count = await deps.db.select({ n: sql<number>`count(*)::int` }).from(portRoutes).where(eq(portRoutes.oriId, ori.id));
  if (!existing && (count[0]?.n ?? 0) >= MAX_ROUTES_PER_ORI) {
    throw new RouteError(409, "limit_reached", `at most ${MAX_ROUTES_PER_ORI} hosted ports per ori`);
  }

  const dial = await dialFor(deps, ori.machineId, port);
  if (!dial) {
    throw new RouteError(400, "machine_not_running", "the ori's machine cannot reach this port (no host-side address)");
  }

  const subdomain = await ensureSubdomain(deps, ori.id);
  const publicRoute = req.public === true;
  // Sticky per (ori, port) across stop/resume, but tied to the access mode: a route that is
  // now public has no token to hand out, and one flipped back to private needs a token that
  // is actually STORED — /internal/edge/validate compares against the row, so a minted-but-
  // unpersisted token would gate the URL shut.
  const title = req.title ?? existing?.title ?? null;
  const token = publicRoute ? null : (existing?.token ?? mintRouteToken());
  const hostname = routeHostname(subdomain, port);

  await deps.db
    .insert(portRoutes)
    .values({ oriId: ori.id, port, subdomain, title, public: publicRoute, token, createdAt: new Date() })
    .onConflictDoUpdate({
      target: [portRoutes.oriId, portRoutes.port],
      set: { title, public: publicRoute, token },
    });

  // Reconcile the edge. A failure here does not roll back the DB row (the URL is real, and
  // the next register call retries the edge), but it IS reported so the caller knows the
  // route is not live yet.
  try {
    await deps.routes?.addRoute({ hostname, dial, gate: !publicRoute });
  } catch (e) {
    throw new RouteError(502, "gateway_error", `edge route registration failed: ${(e as Error).message}`);
  }

  return {
    oriId: ori.id,
    port,
    subdomain,
    hostname,
    url: `https://${hostname}`,
    access: publicRoute ? "public" : "private",
    isProtected: !publicRoute,
    title,
    token,
  };
}

/** Remove one hosted port: DB row + edge route. The token is dropped with the row. */
export async function removePortRoute(deps: AppDeps, oriId: string, port: number): Promise<boolean> {
  const row = await deps.db.query.portRoutes.findFirst({
    where: and(eq(portRoutes.oriId, oriId), eq(portRoutes.port, port)),
  });
  if (!row) return false;
  await deps.db.delete(portRoutes).where(and(eq(portRoutes.oriId, oriId), eq(portRoutes.port, port)));
  try {
    await deps.routes?.removeRoute(routeHostname(row.subdomain, port));
  } catch {
    // The DB row is gone; a stale edge entry is retried on the next register/teardown pass.
  }
  return true;
}

/**
 * Remove the EDGE entries for every hosted port, keeping the DB rows. Used by stop: the
 * machine is gone so the URLs must stop resolving, but resume re-registers the same
 * hostname/token (Box: "Hosting the same port again after a resume returns the same URL
 * and token, so links you handed out keep working").
 */
export async function teardownEdgeRoutes(deps: AppDeps, oriId: string): Promise<number> {
  const rows = await deps.db.select().from(portRoutes).where(eq(portRoutes.oriId, oriId));
  for (const r of rows) {
    try {
      await deps.routes?.removeRoute(routeHostname(r.subdomain, r.port));
    } catch {
      // best-effort; the row is the truth and resume/next register retries the edge
    }
  }
  return rows.length;
}

/** Remove every hosted route for a ori, rows and edge (delete teardown). */
export async function removeAllPortRoutes(deps: AppDeps, oriId: string): Promise<number> {
  const rows = await deps.db.select().from(portRoutes).where(eq(portRoutes.oriId, oriId));
  for (const r of rows) {
    await removePortRoute(deps, oriId, r.port);
  }
  return rows.length;
}

/** Re-add every stored route's edge entry (resume/fork: the machine is fresh). */
export async function reregisterAllPortRoutes(deps: AppDeps, oriId: string): Promise<void> {
  const rows = await deps.db.select().from(portRoutes).where(eq(portRoutes.oriId, oriId));
  if (rows.length === 0) return;
  const machineId = (await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) }))?.machineId ?? null;
  for (const r of rows) {
    const dial = await dialFor(deps, machineId, r.port);
    if (!dial) continue;
    try {
      await deps.routes?.addRoute({ hostname: routeHostname(r.subdomain, r.port), dial, gate: !r.public });
    } catch {
      // best-effort; the row is the truth and the next register retries
    }
  }
}

/** Validate a `_token` query parameter against a hosted hostname. */
export async function validateRouteToken(deps: AppDeps, hostname: string, token: string | null): Promise<boolean> {
  const row = await routeForHostname(deps, hostname);
  if (!row || row.public) return false;
  if (!row.token || !token) return false;
  const a = Buffer.from(row.token);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Public + internal route endpoints.
 *
 * The public surface (bearer, owner-only) is what `ori host` on the laptop calls; the
 * internal surface (machine token, /internal/oris/:id/*) is what the in-box `host` CLI
 * calls. Both funnel into registerPortRoute/removePortRoute so they cannot drift.
 */
export function registerPortRouteRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const b = BASE_PATH;

  const parseRouteBody = (body: unknown): RouteRequest | { error: { status: number; code: string; message: string } } => {
    if (typeof body !== "object" || body === null) return { error: { status: 400, code: "invalid_json", message: "invalid body" } };
    const { port, title, public: isPublic } = body as Record<string, unknown>;
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return { error: { status: 400, code: "invalid_json", message: "port must be an integer 1-65535" } };
    }
    return { port: p, title: typeof title === "string" ? title : undefined, public: isPublic === true };
  };

  /** Shared register handler for both the public and internal surfaces. */
  async function handleRegister(c: Context<AppEnv>, oriId: string) {
    const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
    if (!row) return c.json(fail(404, "not_found"), 404);
    if (!(ACTIVE as readonly string[]).includes(row.state)) {
      return c.json(fail(409, "machine_not_running", "hosting needs the ori's machine running"), 409);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = parseRouteBody(body);
    if ("error" in parsed) {
      const st = parsed.error.status as 400 | 409 | 500;
      return c.json(fail(st, parsed.error.code as never, parsed.error.message), st);
    }
    try {
      const route = await registerPortRoute(deps, row, parsed);
      return c.json(ok("route.registered", { ...route, success: true }));
    } catch (e) {
      if (e instanceof RouteError) {
        const st = e.status as 400 | 409 | 500;
        return c.json(fail(st, e.code as never, e.message), st);
      }
      return c.json(fail(500, "internal_error"), 500);
    }
  }

  // Public (bearer, owner): used by `ori host <id> <port>`.
  app.post(`${b}/oris/:oriId/routes`, async (c) => {
    const oriId = c.req.param("oriId");
    const owned = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriId), eq(oris.userId, c.get("userId")!)),
    });
    if (!owned) return c.json(fail(404, "not_found"), 404);
    return handleRegister(c, oriId);
  });

  app.get(`${b}/oris/:oriId/routes`, async (c) => {
    const oriId = c.req.param("oriId");
    const owned = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriId), eq(oris.userId, c.get("userId")!)),
    });
    if (!owned) return c.json(fail(404, "not_found"), 404);
    const rows = await deps.db.select().from(portRoutes).where(eq(portRoutes.oriId, oriId));
    return c.json(
      ok("route.list", {
        routes: rows.map((r) => ({
          oriId,
          port: r.port,
          subdomain: r.subdomain,
          hostname: routeHostname(r.subdomain, r.port),
          url: `https://${routeHostname(r.subdomain, r.port)}`,
          access: r.public ? "public" : "private",
          isProtected: !r.public,
          title: r.title,
          token: r.token,
        })),
      }),
    );
  });

  app.delete(`${b}/oris/:oriId/routes/:port`, async (c) => {
    const oriId = c.req.param("oriId");
    const port = Number(c.req.param("port"));
    const owned = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriId), eq(oris.userId, c.get("userId")!)),
    });
    if (!owned) return c.json(fail(404, "not_found"), 404);
    const removed = await removePortRoute(deps, oriId, port);
    if (!removed) return c.json(fail(404, "not_found"), 404);
    return c.json(ok("route.removed", { oriId, port }));
  });

  // Internal (machine token): the in-box `host` CLI. The machine-token middleware is
  // already mounted on /internal/oris/:id/* by routes/internal.ts; these handlers only
  // re-check that the :id is the token's own ori.
  app.post(`/internal/oris/:id/routes`, async (c) => {
    const oriId = c.req.param("id");
    if (oriId !== c.get("machineOriId")) return c.json(fail(404, "not_found"), 404);
    return handleRegister(c, oriId);
  });
  app.get(`/internal/oris/:id/routes`, async (c) => {
    const oriId = c.req.param("id");
    if (oriId !== c.get("machineOriId")) return c.json(fail(404, "not_found"), 404);
    const rows = await deps.db.select().from(portRoutes).where(eq(portRoutes.oriId, oriId));
    return c.json(
      ok("route.list", {
        routes: rows.map((r) => ({
          port: r.port,
          hostname: routeHostname(r.subdomain, r.port),
          url: `https://${routeHostname(r.subdomain, r.port)}`,
          access: r.public ? "public" : "private",
          isProtected: !r.public,
          title: r.title,
          token: r.token,
        })),
      }),
    );
  });
  app.delete(`/internal/oris/:id/routes/:port`, async (c) => {
    const oriId = c.req.param("id");
    if (oriId !== c.get("machineOriId")) return c.json(fail(404, "not_found"), 404);
    await removePortRoute(deps, oriId, Number(c.req.param("port")));
    return c.json(ok("route.removed", { oriId }));
  });

  // Edge endpoints (unauth'd by design; they answer existence/token only).
  app.get(`/internal/edge/ask`, async (c) => {
    const domain = c.req.query("domain");
    if (!domain) return c.text("domain required", 400);
    return (await routeForHostname(deps, domain)) ? c.text("ok") : c.text("not registered", 404);
  });

  app.get(`/internal/edge/validate`, async (c) => {
    const host = c.req.header("x-forwarded-host");
    const uri = c.req.header("x-forwarded-uri") ?? "";
    const token = new URL(uri, "http://x").searchParams.get("_token");
    if (!host) return c.text("missing host", 400);
    const valid = await validateRouteToken(deps, host, token);
    return valid ? c.text("ok") : c.text("forbidden", 403);
  });
}
