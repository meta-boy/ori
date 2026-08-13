import { signV4 } from "./sigv4";
import { oriRepoUrl } from "./restic";

/**
 * Per-ori storage credentials (T-P5-02). The control plane hands each ori a
 * short-TTL S3 credential that can touch ONLY that ori's repo prefix — the
 * security invariant of §5:
 *
 *   a ori has sudo, so anything we put inside it is readable by the ori.
 *   The credentials a ori receives must therefore be (a) scoped to that ori's
 *   object prefix and nothing else, and (b) expire within an hour.
 *
 * MECHANISM — MinIO STS AssumeRole with an inline session policy (dev; R2
 * scoped API tokens in prod). Why STS and not a service account:
 *
 *   - Service accounts are long-lived: they have no expiry, so handing one to
 *     a ori violates invariant (b) unless we mint-and-delete one per request,
 *     which is racy and leaves permanent credentials lying around on failures.
 *   - STS sessions expire natively (DurationSeconds, capped at 1h here) with
 *     zero bookkeeping, and the session policy is enforced by the object
 *     store's own policy engine — the scoping is real, not our code politely
 *     passing the right prefix.
 *
 * The temporary credential is the intersection of the parent (root) policy and
 * the session policy, so minioadmin's full access is narrowed to exactly
 * `oris/<oriId>/*` for the life of the session.
 */

/** Invariant ceiling: no credential may outlive an hour. */
export const STORAGE_CRED_TTL_SECONDS = 3600;

export interface StorageConfig {
  /**
   * The endpoint the CONTROL PLANE uses (STS, admin calls). e.g. `http://localhost:9000`.
   * Scheme included; trailing slash optional.
   */
  endpoint: string;
  /**
   * The endpoint a ORI must use, when it differs. It usually does: from inside a container
   * `localhost:9000` is the container itself, so a ori handed the control plane's address
   * cannot reach the object store at all — verified, it is not merely theoretical. On
   * Docker Desktop the working address is `host.docker.internal:9000`. Defaults to
   * `endpoint` for a deployment where both sides share one address.
   */
  oriEndpoint?: string;
  /** Control-plane root credentials — never handed to a ori. */
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

export interface OriStorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  region: string;
  /** When the object store revokes the session. */
  expiresAt: Date;
  durationSeconds: number;
  endpoint: string;
  bucket: string;
  /** The object prefix this credential is restricted to: `oris/<oriId>/`. */
  prefix: string;
  /** The restic repo URL for this ori: `s3:<endpoint>/<bucket>/oris/<oriId>`. */
  repoUrl: string;
  /**
   * True when the session is narrowed to GetObject + ListBucket (cross-ori
   * fork-restore). Read-write sessions (own-prefix snapshot/restore) carry false.
   */
  readOnly: boolean;
}

/** Control-plane S3 config, from env, with docker-compose dev defaults. */
export function storageConfigFromEnv(): StorageConfig {
  return {
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    // S3_ENDPOINT_FOR_ORI exists because the two sides genuinely differ under Docker.
    oriEndpoint: process.env.S3_ENDPOINT_FOR_ORI ?? process.env.S3_ENDPOINT ?? "http://localhost:9000",
    accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
    bucket: process.env.S3_BUCKET ?? "ori-snapshots",
    region: process.env.S3_REGION ?? "us-east-1",
  };
}

/** The object prefix a ori's storage credentials are restricted to. */
export function oriStoragePrefix(oriId: string): string {
  return `oris/${oriId}/`;
}

/**
 * Session policy: objects under `oris/<oriId>/*`, plus a ListBucket that is
 * itself prefix-restricted so a ori cannot enumerate the whole bucket.
 *
 * `readOnly` narrows the object actions to GetObject + ListBucket and drops
 * PutObject/DeleteObject entirely. That is the cross-ori fork-restore case
 * (OPEN-DECISIONS #2): a fork restores from its PARENT's prefix, and the restore
 * path never writes to the source repo, so the fork's short-lived credential is
 * read-only there. Read access is inherent to forking; write access is not.
 */
function sessionPolicy(bucket: string, oriId: string, readOnly: boolean): string {
  const prefix = oriStoragePrefix(oriId);
  const objectActions = readOnly ? ["s3:GetObject"] : ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"];
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: objectActions,
        Resource: [`arn:aws:s3:::${bucket}/${prefix}*`],
      },
      {
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [`arn:aws:s3:::${bucket}`],
        Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
      },
    ],
  });
}

/** Pull one leaf out of the STS XML response. */
function xmlLeaf(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

export interface MintOptions {
  /** Injectable clock for deterministic expiry assertions. */
  now?: Date;
  /** TTL of the minted session; hard-capped at STORAGE_CRED_TTL_SECONDS. */
  ttlSeconds?: number;
  /**
   * Narrow the session to GetObject + ListBucket (no PutObject/DeleteObject). Set when the
   * requesting ori is NOT the owner of the object prefix — a fork restoring from its
   * parent's repo. The restore path never writes to the source repo (OPEN-DECISIONS #2).
   */
  readOnly?: boolean;
}

/**
 * Mint short-TTL, prefix-scoped credentials for a ori via MinIO STS
 * AssumeRole. Throws on any failure (minio down, non-2xx, malformed reply) —
 * the route maps that to a 502.
 */
export async function mintOriStorageCredentials(
  config: StorageConfig,
  oriId: string,
  opts: MintOptions = {},
): Promise<OriStorageCredentials> {
  const now = opts.now ?? new Date();
  const ttlSeconds = opts.ttlSeconds ?? STORAGE_CRED_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > STORAGE_CRED_TTL_SECONDS) {
    throw new Error(`storage-cred TTL must be 1..${STORAGE_CRED_TTL_SECONDS}s, got ${ttlSeconds}`);
  }
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const region = config.region ?? "us-east-1";

  // Policy travels percent-encoded in the form body; the + vs %20 distinction
  // matters because JSON is full of spaces, so build the body by hand.
  const body = [
    "Action=AssumeRole",
    "Version=2011-06-15",
    `DurationSeconds=${ttlSeconds}`,
    `Policy=${encodeURIComponent(sessionPolicy(config.bucket, oriId, opts.readOnly === true))}`,
  ].join("&");

  const signed = signV4({
    method: "POST",
    url: `${endpoint}/`,
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    region,
    service: "sts",
    now,
  });

  const res = await fetch(signed.url, {
    method: "POST",
    headers: signed.headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`storage-credential mint failed (${res.status}): ${text}`);
  }

  const accessKeyId = xmlLeaf(text, "AccessKeyId");
  const secretAccessKey = xmlLeaf(text, "SecretAccessKey");
  const sessionToken = xmlLeaf(text, "SessionToken");
  const expiration = xmlLeaf(text, "Expiration");
  if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) {
    throw new Error(`storage-credential mint returned no session credentials: ${text}`);
  }

  // The endpoint returned to the caller is the ORI-facing one: these credentials exist to
  // be used from inside a ori, and `endpoint` above is the control plane's own address for
  // STS, which a container cannot reach. Where they are the same, oriEndpoint defaults to it.
  const forOri = config.oriEndpoint ?? endpoint;

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    region,
    expiresAt: new Date(expiration),
    durationSeconds: ttlSeconds,
    endpoint: forOri,
    bucket: config.bucket,
    prefix: oriStoragePrefix(oriId),
    repoUrl: oriRepoUrl(forOri, config.bucket, oriId),
    readOnly: opts.readOnly === true,
  };
}
