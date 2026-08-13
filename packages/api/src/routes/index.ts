import type { AppDeps, AppEnv } from "../context";
import type { Hono } from "hono";
import { registerUserRoutes } from "./user";
import { registerOriRoutes } from "./oris";
import { registerInternalRoutes } from "./internal";
import { registerSnapshotRoutes } from "./snapshots";
import { registerAuthRoutes } from "./auth";
import { registerPortRouteRoutes } from "./portRoutes";

/**
 * Mounts every control-plane route group. Groups that need the auth middleware
 * register inside `src/routes/user.ts`; lifecycle/ori routes register under P3;
 * the §5 internal API (machine-token authed) registers in `src/routes/internal.ts`.
 */
export function registerRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  // Auth first, and outside /api/ori/v1: a login arrives without credentials, so these must
  // not sit behind the bearer middleware.
  registerAuthRoutes(app, deps);
  registerUserRoutes(app, deps);
  registerOriRoutes(app, deps);
  registerSnapshotRoutes(app, deps);
  registerInternalRoutes(app, deps);
  registerPortRouteRoutes(app, deps);
}