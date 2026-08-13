import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { fail, ok } from "@ori/contract";
import { oris } from "../db/schema";
import type { AppDeps, AppEnv } from "../context";
import { machineAuthMiddleware } from "../middleware/machineAuth";
import {
  mintOriStorageCredentials,
  storageConfigFromEnv,
  type OriStorageCredentials,
} from "../snapshots/storageCreds";

/**
 * §5 control-plane internal API. Not on the public `/api/ori/v1` surface and
 * NOT API-key authed — these endpoints are called by oris themselves with
 * their per-ori machine token, which authorizes only
 * `/internal/oris/<own-id>/*`.
 *
 * Security invariant (§5): a ori has sudo, so anything we put inside it is
 * readable by the ori. Credentials handed to a ori are scoped to that ori's
 * object prefix by the OBJECT STORE (MinIO session policy), expire in ≤1h,
 * and no other ori's data is ever reachable from inside a ori.
 */
export function registerInternalRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const internal = "/internal";

  app.use(`${internal}/oris/:id/*`, machineAuthMiddleware(deps));

  // GET /internal/oris/:id/storage-creds — short-TTL S3 credentials scoped
  // to this ori's repo prefix, plus the restic repo URL the guest should use.
  app.get(`${internal}/oris/:id/storage-creds`, async (c) => {
    const oriId = c.req.param("id");

    // A machine token is scoped to exactly one ori. Anything else is 404 —
    // never a success, and without leaking whether the other ori exists.
    if (oriId !== c.get("machineOriId")) {
      return c.json(fail(404, "not_found"), 404);
    }
    const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
    if (!row) return c.json(fail(404, "not_found"), 404);

    // An archived ori has no live machine and nobody should be calling for
    // creds; its machine token stays inert until a resume reuses it.
    if (row.state === "archived") {
      return c.json(fail(404, "not_found"), 404);
    }

    let creds: OriStorageCredentials;
    try {
      creds = await mintOriStorageCredentials(storageConfigFromEnv(), oriId);
    } catch (e) {
      return c.json(fail(502, "gateway_error", (e as Error).message), 502);
    }

    return c.json(
      ok("storage.creds", {
        repoUrl: creds.repoUrl,
        endpoint: creds.endpoint,
        bucket: creds.bucket,
        prefix: creds.prefix,
        region: creds.region,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
        expiresAt: creds.expiresAt.toISOString(),
        expiresInSeconds: creds.durationSeconds,
      }),
    );
  });
}
