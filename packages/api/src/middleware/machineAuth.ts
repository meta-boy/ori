import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { fail } from "@ori/contract";
import { oris } from "../db/schema";
import type { AppDeps, AppEnv } from "../context";
import { sha256Hex, timingSafeEqualHex } from "./auth";
// Imported, never redeclared: a local copy of this regex drifted from the generator and
// made every real machine token 401.
import { MACHINE_TOKEN_REGEX } from "../tokens";

function unauthorized(c: { get: <K extends keyof AppEnv["Variables"]>(k: K) => AppEnv["Variables"][K] }) {
  const body = fail(401, "unauthorized") as { ok: false; requestId: string };
  body.requestId = c.get("requestId");
  return Response.json(body, { status: 401, headers: { "x-request-id": c.get("requestId") } });
}

/** A machine token is `ori_mt_` + 64 hex (tokens.ts). */

/**
 * Per-ori machine-token auth for `/internal/oris/*` (the §5 control-plane
 * API). The token is minted at provision time and only its sha256 hash is
 * stored on the oris row, so this is the auth.ts pattern — hash the
 * presented token, look the hash up, verify with a timing-safe compare.
 *
 * The middleware resolves the token to ITS ori (`machineOriId`); each route
 * then rejects any `:id` that is not that ori. A machine token is scoped to
 * `/internal/oris/<own-id>/*` and to nothing else — presenting ori A's token
 * on ori B's path must fail closed in the route.
 */
export function machineAuthMiddleware(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token || !MACHINE_TOKEN_REGEX.test(token)) {
      return unauthorized(c);
    }

    const hash = sha256Hex(token);
    const ori = await deps.db.query.oris.findFirst({
      where: eq(oris.machineTokenHash, hash),
    });
    if (!ori || !timingSafeEqualHex(hash, ori.machineTokenHash ?? "")) {
      return unauthorized(c);
    }

    c.set("machineOriId", ori.id);
    await next();
  };
}
