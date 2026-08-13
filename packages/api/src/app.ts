import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { resolve, sep } from "node:path";
import { requestIdMiddleware } from "./middleware/requestId";
import { authMiddleware } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { registerRoutes } from "./routes/index";
import { BASE_PATH, type AppDeps, type AppEnv } from "./context";

/**
 * The control plane answers the whole envelope surface (success
 * `{ok,type,…}` and `ori.error` alike) under /api/ori/v1.
 */
export { BASE_PATH };

/**
 * Static dashboard root: the Vite BUILD output, not the source.
 *
 * There is a build step now (`bun run --cwd packages/dashboard build`), which is the cost of
 * moving to React + Tailwind + shadcn. If this directory is missing the handler says so rather
 * than 404ing every asset, because "I forgot to build" and "the route is broken" look identical
 * otherwise.
 */
const DASHBOARD_DIR = resolve(import.meta.dir, "../../dashboard/dist");

/**
 * Serve the web dashboard at /dashboard. Deliberately OUTSIDE the auth middleware:
 * the dashboard has its own paste-an-API-key login and must be reachable before any
 * key exists. No framework, no build step — plain files, path traversal refused.
 */
async function dashboardHandler(c: Context<AppEnv>) {
  const url = new URL(c.req.url);
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname.replace(/^\/dashboard\/?/, ""));
  } catch {
    return c.text("bad request", 400);
  }
  if (rel === "" ) rel = "index.html";
  if (rel.includes("\0") || rel.includes("\\")) return c.text("forbidden", 403);

  const target = resolve(DASHBOARD_DIR, rel);
  if (target !== DASHBOARD_DIR && !target.startsWith(DASHBOARD_DIR + sep)) {
    // Refuse anything that resolves outside the dashboard directory, whether the
    // dot segments arrived raw or already normalised by the URL parser.
    return c.text("forbidden", 403);
  }

  const file = Bun.file(target);
  if (await file.exists()) {
    return new Response(file, {
      headers: {
        "content-type": file.type || "application/octet-stream",
        // Vite fingerprints asset filenames, so they are safe to cache hard. index.html must not
        // be, or a deploy leaves browsers pinned to a stale bundle that references gone assets.
        "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  }

  // Nothing built yet is a different failure from a wrong path, and saying which saves an hour.
  if (!(await Bun.file(resolve(DASHBOARD_DIR, "index.html")).exists())) {
    return c.text(
      "dashboard not built — run: bun run --cwd packages/dashboard build",
      503,
    );
  }
  return c.text("not found", 404);
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use(requestIdMiddleware());
  // 16MB: comfortably above the 10MB file cap plus base64's ~33% inflation, so
  // the guest agent (not this middleware) is what rejects over-cap writes.
  app.use(`${BASE_PATH}/*`, bodyLimit({ maxSize: 16 * 1024 * 1024, onError: (c) => c.text("body too large", 413) }));
  app.use(`${BASE_PATH}/*`, authMiddleware(deps));

  registerRoutes(app, deps);

  // ponytail: no landing page. The dashboard already renders sign-in/sign-up when the
  // session cookie is missing and the app when it is not, so / just goes there.
  app.get("/", (c) => c.redirect("/dashboard"));

  app.get("/dashboard", dashboardHandler);
  app.get("/dashboard/*", dashboardHandler);

  app.notFound(notFoundHandler);
  app.onError(errorHandler);

  return app;
}