import { and, desc, eq } from "drizzle-orm";
import { snapshotId } from "@ori/contract";
import { oris, snapshots, snapshotChunks } from "../db/schema";
import type { AppDeps } from "../context";

/**
 * T-P5-04 — persist a completed snapshot on the control-plane side.
 *
 * Given the result of a guest `POST /snapshot`, write one `snapshots` row plus its
 * `snapshot_chunks` rows and update the ori's `snapshot_available`,
 * `snapshot_completed_at`, `last_snapshot_attempt_at`, `last_snapshot_status` and
 * `snapshot_skip_streak` fields, so the reaper and the public snapshots
 * endpoints (T-P5-08) tell the truth about what exists.
 *
 * EVERY ori-row write for a snapshot attempt belongs here, in the same statement — a caller
 * that follows this with its own UPDATE can crash between the two and leave, say, a completed
 * snapshot next to a skip streak that keeps the sandbox on an hour-long cadence.
 *
 * SKIP STREAK: reset to 0 by both outcomes. A confirmed backup means the disk changed, and a
 * failure means the disk's state is unknown; either way the next probe belongs at the base
 * cadence rather than compounding with the idle backoff. Only a SKIP advances it (see
 * takeSnapshot), and a skip never reaches this function — nothing is registered for it.
 *
 * CHAIN FIELDS are computed here, not by the guest: the guest cannot know the
 * control plane's chain bookkeeping. generation increments per ori (first = 1),
 * chainId groups a base with its incrementals (minted on the first snapshot,
 * reused afterwards), and kind is 'base' for the first snapshot and 'incremental'
 * after. Our first snapshot is generation 1 — the OpenAPI's SnapshotSummary prose
 * says "0 = base"; the difference is declared in docs/DIVERGENCES.md.
 *
 * IDEMPOTENT: registering the same restic snapshot id twice is a no-op — a retry
 * after a network blip is normal. The check is a SELECT on (ori_id, restic_id)
 * before the INSERT; the schema is used as-is, so there is no unique index to
 * back it up, which is acceptable for sequential retries.
 *
 * FAILURE: a failed snapshot records last_snapshot_status='failed' and
 * last_snapshot_attempt_at, and MUST NOT touch snapshot_available. A ori that has
 * an older good snapshot still has one, so that flag is the truth the reaper's
 * zero-rating window keys on.
 *
 * CHUNKS: each chunk is one restic data pack object — content-addressed, deduped,
 * and shared between generations, so per-generation attribution is not real. The
 * mapping and its consequence for download are declared in docs/DIVERGENCES.md.
 */

/** A restic data pack object: one deduped, content-addressed storage unit. */
export interface SnapshotChunkInput {
  /** Object key in the ori's repo prefix, e.g. `oris/<oriId>/data/<sha256>`. */
  r2Key: string;
  sizeBytes: number;
  /** SHA-256 of the pack object's contents (restic names packs by it). */
  sha256: string;
}

/** A successful guest `/snapshot` result, as registered by the control plane. */
export interface SnapshotCreatedResult {
  ok: true;
  type: "snapshot.created";
  mode: "auto" | "final";
  /** restic snapshot id (64 hex). */
  snapshotId: string;
  /** Logical bytes captured, INCLUDING the sysdiff (restic totalBytesProcessed). */
  sizeBytes: number;
  /** Files captured, INCLUDING the sysdiff (restic totalFilesProcessed). */
  fileCount: number;
  /** Bytes of the ori's own data (the work dir), sysdiff EXCLUDED. */
  contentSizeBytes: number;
  /** Files of the ori's own data (the work dir), sysdiff EXCLUDED. */
  contentFileCount: number;
  /** The data packs this snapshot's registration records, in download order. */
  chunks: SnapshotChunkInput[];
  /** When the guest finished the backup. Defaults to the registration time. */
  createdAt?: string;
}

/** A failed guest `/snapshot` result. */
export interface SnapshotFailedResult {
  ok: false;
  type: "snapshot.failed";
  mode: "auto" | "final";
  error?: string;
}

export type SnapshotRegistration = SnapshotCreatedResult | SnapshotFailedResult;

export interface RegisteredSnapshot {
  id: string;
  oriId: string;
  chainId: string | null;
  generation: number;
  kind: string | null;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  sizeBytes: number;
  fileCount: number;
  contentSizeBytes: number | null;
  contentFileCount: number | null;
  resticId: string | null;
  chunkCount: number;
  /** true when this call found an existing row for the same restic id. */
  idempotent: boolean;
}

export type RegisterOutcome =
  | { ok: true; snapshot: RegisteredSnapshot }
  | { ok: false; attemptedAt: Date };

/**
 * Register a snapshot result for a ori. A missing ori throws — the caller decides
 * what status to surface (the internal route is machine-token scoped to a ori that
 * already exists, so this is a programming error, not a client condition).
 */
export async function registerSnapshot(
  deps: AppDeps,
  oriId: string,
  result: SnapshotRegistration,
): Promise<RegisterOutcome> {
  const ori = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  if (!ori) throw new Error(`registerSnapshot: ori ${oriId} not found`);

  const now = deps.now?.() ?? new Date();

  if (!result.ok) {
    await deps.db
      .update(oris)
      .set({ lastSnapshotStatus: "failed", lastSnapshotAttemptAt: now, updatedAt: now, snapshotSkipStreak: 0 })
      .where(eq(oris.id, oriId));
    return { ok: false, attemptedAt: now };
  }

  const existing = await deps.db.query.snapshots.findFirst({
    where: and(eq(snapshots.oriId, oriId), eq(snapshots.resticId, result.snapshotId)),
  });
  if (existing) {
    const chunks = await deps.db
      .select()
      .from(snapshotChunks)
      .where(eq(snapshotChunks.snapshotId, existing.id));
    return { ok: true, snapshot: { ...existing, chunkCount: chunks.length, idempotent: true } };
  }

  const latest = await deps.db.query.snapshots.findFirst({
    where: eq(snapshots.oriId, oriId),
    orderBy: (s, { desc }) => [desc(s.generation)],
  });
  const generation = (latest?.generation ?? 0) + 1;
  const chainId = latest?.chainId ?? snapshotId();
  const kind = generation === 1 ? "base" : "incremental";

  const id = snapshotId();
  const completedAt = now;
  const createdAt = result.createdAt ? new Date(result.createdAt) : now;

  await deps.db.insert(snapshots).values({
    id,
    oriId,
    chainId,
    generation,
    kind,
    status: "completed",
    createdAt,
    completedAt,
    sizeBytes: result.sizeBytes,
    fileCount: result.fileCount,
    contentSizeBytes: result.contentSizeBytes,
    contentFileCount: result.contentFileCount,
    resticId: result.snapshotId,
  });

  const chunkRows = result.chunks.map((chunk, chunkIndex) => ({
    snapshotId: id,
    chunkIndex,
    r2Key: chunk.r2Key,
    sizeBytes: chunk.sizeBytes,
    sha256: chunk.sha256,
  }));
  if (chunkRows.length > 0) {
    await deps.db.insert(snapshotChunks).values(chunkRows);
  }

  await deps.db
    .update(oris)
    .set({
      snapshotAvailable: true,
      snapshotCompletedAt: completedAt,
      lastSnapshotAttemptAt: completedAt,
      lastSnapshotStatus: "completed",
      snapshotSkipStreak: 0,
      updatedAt: completedAt,
    })
    .where(eq(oris.id, oriId));

  return {
    ok: true,
    snapshot: {
      id,
      oriId,
      chainId,
      generation,
      kind,
      status: "completed",
      createdAt,
      completedAt,
      sizeBytes: result.sizeBytes,
      fileCount: result.fileCount,
      contentSizeBytes: result.contentSizeBytes,
      contentFileCount: result.contentFileCount,
      resticId: result.snapshotId,
      chunkCount: chunkRows.length,
      idempotent: false,
    },
  };
}
