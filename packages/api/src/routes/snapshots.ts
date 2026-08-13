import type { Hono } from "hono";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { fail, ok, paginate } from "@ori/contract";
import { oris, snapshots } from "../db/schema";
import { BASE_PATH, type AppDeps, type AppEnv } from "../context";
import { Restic } from "../snapshots/restic";
import { mintGuestStorage } from "../snapshots/take";

/**
 * The public snapshot read surface: T-P5-08 list/latest, T-P5-09 tree, T-P5-10 file or
 * folder-as-tar, T-P5-11 download.
 *
 * Every one of these reads a ori's restic repository, so every one needs storage
 * credentials for the ori that OWNS the snapshot — not the caller's ori, and not an
 * account-wide credential. mintGuestStorage(oriId) is the single place that mints, shared
 * with snapshot and restore, so all three cannot drift apart (they did, twice).
 *
 * Ownership is checked by joining through `oris.userId`: a snapshot id is a uuid, and
 * without the join any user could read any other user's snapshot by guessing one. Both the
 * "not yours" and "does not exist" answers are an identical 404, so the endpoint cannot be
 * used to discover which snapshot ids are real.
 */

/** A snapshot row plus its owning ori, or null when it is not this user's. */
async function ownedSnapshot(deps: AppDeps, snapshotId: string, userId: string) {
  const rows = await deps.db
    .select({ snap: snapshots, oriUser: oris.userId })
    .from(snapshots)
    .innerJoin(oris, eq(oris.id, snapshots.oriId))
    .where(and(eq(snapshots.id, snapshotId), eq(oris.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** A restic client bound to the repository that holds this snapshot. */
async function resticFor(oriId: string): Promise<Restic> {
  const storage = await mintGuestStorage(oriId);
  return new Restic({
    bin: process.env.RESTIC_BIN ?? "restic",
    repo: storage.repoUrl,
    password: storage.password,
    s3: {
      endpoint: storage.endpoint,
      accessKey: storage.credentials.accessKeyId,
      secretKey: storage.credentials.secretAccessKey,
      sessionToken: storage.credentials.sessionToken,
      region: storage.region,
    },
  });
}

function toSummary(s: typeof snapshots.$inferSelect) {
  return {
    id: s.id,
    oriId: s.oriId,
    status: s.status,
    kind: s.kind,
    generation: s.generation,
    chainId: s.chainId,
    createdAt: s.createdAt.toISOString(),
    completedAt: s.completedAt ? s.completedAt.toISOString() : null,
    sizeBytes: s.sizeBytes,
    fileCount: s.fileCount,
    contentSizeBytes: s.contentSizeBytes,
    contentFileCount: s.contentFileCount,
  };
}

/** Cursor is base64url of `<createdAtEpochMs>:<id>`, matching the oris list. */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.getTime()}:${row.id}`).toString("base64url");
}
function decodeCursor(cursor: string): { at: Date; id: string } | null {
  try {
    const [ms, id] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
    if (!ms || !id) return null;
    return { at: new Date(Number(ms)), id };
  } catch {
    return null;
  }
}

export function registerSnapshotRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const b = BASE_PATH;

  /** GET /snapshots — every completed snapshot across the caller's oris, newest first. */
  app.get(`${b}/snapshots`, async (c) => {
    const userId = c.get("userId")!;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 100);
    const cursor = c.req.query("cursor") ?? null;

    const conds = [eq(oris.userId, userId), eq(snapshots.status, "completed")];
    if (cursor) {
      const cur = decodeCursor(cursor);
      if (!cur) return c.json(fail(400, "invalid_json", "malformed cursor"), 400);
      conds.push(
        or(
          lt(snapshots.createdAt, cur.at),
          and(eq(snapshots.createdAt, cur.at), lt(snapshots.id, cur.id)),
        )!,
      );
    }

    const rows = await deps.db
      .select({ snap: snapshots })
      .from(snapshots)
      .innerJoin(oris, eq(oris.id, snapshots.oriId))
      .where(and(...conds))
      .orderBy(desc(snapshots.createdAt), desc(snapshots.id))
      .limit(limit + 1);

    const { page, pageInfo } = paginate({
      rows: rows.map((r) => r.snap),
      limit,
      cursor,
      encodeCursor,
    });
    return c.json(ok("snapshot.list", { snapshots: page.map(toSummary), pageInfo }));
  });

  /** GET /oris/{oriId}/snapshots — one ori's snapshots, newest first. */
  app.get(`${b}/oris/:oriId/snapshots`, async (c) => {
    const userId = c.get("userId")!;
    const oriId = c.req.param("oriId");
    const ori = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriId), eq(oris.userId, userId)),
    });
    if (!ori) return c.json(fail(404, "not_found"), 404);

    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 100);
    const cursor = c.req.query("cursor") ?? null;
    const conds = [eq(snapshots.oriId, oriId), eq(snapshots.status, "completed")];
    if (cursor) {
      const cur = decodeCursor(cursor);
      if (!cur) return c.json(fail(400, "invalid_json", "malformed cursor"), 400);
      conds.push(
        or(lt(snapshots.createdAt, cur.at), and(eq(snapshots.createdAt, cur.at), lt(snapshots.id, cur.id)))!,
      );
    }
    const rows = await deps.db
      .select()
      .from(snapshots)
      .where(and(...conds))
      .orderBy(desc(snapshots.createdAt), desc(snapshots.id))
      .limit(limit + 1);

    const { page, pageInfo } = paginate({ rows, limit, cursor, encodeCursor });
    return c.json(ok("snapshot.list", { snapshots: page.map(toSummary), pageInfo }));
  });

  /**
   * GET /oris/{oriId}/snapshots/latest — the newest completed snapshot, or null.
   * `null` rather than 404: the spec's SnapshotLatestResponse allows it, and a ori with no
   * snapshot yet is a normal state a client polls through, not an error.
   */
  app.get(`${b}/oris/:oriId/snapshots/latest`, async (c) => {
    const userId = c.get("userId")!;
    const oriId = c.req.param("oriId");
    const ori = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriId), eq(oris.userId, userId)),
    });
    if (!ori) return c.json(fail(404, "not_found"), 404);

    const rows = await deps.db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.oriId, oriId), eq(snapshots.status, "completed")))
      .orderBy(desc(snapshots.createdAt), desc(snapshots.id))
      .limit(1);
    return c.json(ok("snapshot.latest", { snapshot: rows[0] ? toSummary(rows[0]) : null }));
  });

  /** GET /snapshots/{snapshotId}/tree — the files captured, with sizes. */
  app.get(`${b}/snapshots/:snapshotId/tree`, async (c) => {
    const userId = c.get("userId")!;
    const owned = await ownedSnapshot(deps, c.req.param("snapshotId"), userId);
    if (!owned) return c.json(fail(404, "not_found"), 404);
    const ref = owned.snap.resticId ?? owned.snap.id;

    try {
      const restic = await resticFor(owned.snap.oriId);
      const nodes = await restic.ls(ref);
      // ResticNode.size is always a number (0 for dirs/symlinks), so no conditional here.
      const entries = nodes.map((n) => ({ path: n.path, kind: n.kind, size: n.size }));
      return c.json(ok("snapshot.tree", { snapshotId: owned.snap.id, entries }));
    } catch (e) {
      return c.json(fail(502, "gateway_error", `snapshot tree unavailable: ${(e as Error).message}`), 502);
    }
  });

  /**
   * GET /snapshots/{snapshotId}/files?path= — a single file's bytes, or a folder as tar.
   * restic dump does both; a trailing-slash-free path that happens to be a directory comes
   * back as a tar, which is what the spec describes.
   */
  app.get(`${b}/snapshots/:snapshotId/files`, async (c) => {
    const userId = c.get("userId")!;
    const path = c.req.query("path");
    if (!path) return c.json(fail(400, "invalid_json", "path is required"), 400);
    const owned = await ownedSnapshot(deps, c.req.param("snapshotId"), userId);
    if (!owned) return c.json(fail(404, "not_found"), 404);
    const ref = owned.snap.resticId ?? owned.snap.id;

    try {
      const restic = await resticFor(owned.snap.oriId);
      const dump = await restic.dump(ref, path);
      // Streamed, not buffered: a snapshot folder can be gigabytes and buffering it would
      // put the control plane's memory at the mercy of whatever the user stored.
      return new Response(dump.body, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${path.split("/").pop() || "download"}"`,
        },
      });
    } catch (e) {
      return c.json(fail(502, "gateway_error", `snapshot file unavailable: ${(e as Error).message}`), 502);
    }
  });

  /**
   * GET /snapshots/{snapshotId}/download — how to reconstruct this snapshot.
   *
   * Ori returns presigned URLs for every chunk "ordered by (generation, chunkIndex)", with
   * the implication that fetching them in order reassembles the filesystem. Ours cannot
   * promise that: restic packs are content-addressed containers of compressed blobs, and the
   * blob-to-file mapping lives in restic's index and tree objects. Rather than ship a chunk
   * list that looks reconstructable and is not, `reconstruct` says plainly that recovery goes
   * through restic and `inventory` carries what a restic client needs. See
   * docs/DIVERGENCES.md, "Snapshot chunks, generations and sizes".
   */
  app.get(`${b}/snapshots/:snapshotId/download`, async (c) => {
    const userId = c.get("userId")!;
    const owned = await ownedSnapshot(deps, c.req.param("snapshotId"), userId);
    if (!owned) return c.json(fail(404, "not_found"), 404);

    const storage = await mintGuestStorage(owned.snap.oriId);
    const expiresInSeconds = 3600;
    return c.json(
      ok("snapshot.download", {
        snapshotId: owned.snap.id,
        oriId: owned.snap.oriId,
        kind: owned.snap.kind ?? "base",
        generation: owned.snap.generation,
        expiresInSeconds,
        reconstruct:
          "This snapshot is a restic repository, not a concatenation of chunks. Recover it " +
          "with restic itself: point RESTIC_REPOSITORY at the repoUrl below, supply the " +
          "credentials, and run `restic restore <resticId> --target <dir>`. The chunk list " +
          "identifies the repository's data packs but fetching them in order will NOT " +
          "reassemble a filesystem — the blob-to-file mapping lives in restic's index and " +
          "tree objects. See docs/DIVERGENCES.md.",
        inventory: {
          repoUrl: storage.repoUrl,
          endpoint: storage.endpoint,
          bucket: storage.bucket,
          prefix: storage.prefix,
          resticId: owned.snap.resticId,
          // Credentials are deliberately NOT included. They are short-lived and scoped, but
          // a download manifest is the kind of thing that gets logged and pasted; a caller
          // who needs them asks for them explicitly.
          credentialsHint: "call GET /internal/oris/{oriId}/storage-creds from the ori, or use your own",
        },
        chunks: [],
      }),
    );
  });
}
