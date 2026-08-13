import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 — the subset the control plane needs to talk to an
 * S3/STS endpoint (MinIO in dev, R2 in prod) without pulling in an SDK.
 *
 * Used in exactly two places, both security-critical:
 *   - minting per-ori storage credentials via STS AssumeRole (storageCreds.ts)
 *   - the T-P5-02 cross-ori denial test, which signs real S3 requests with a
 *     ori's scoped credentials to prove the object store itself refuses to
 *     touch another ori's prefix.
 *
 * The implementation follows the documented SigV4 spec: canonical request,
 * string-to-sign, HMAC key derivation. Nothing MinIO-specific.
 */

const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

const hmac = (key: Buffer, input: string): Buffer =>
  createHmac("sha256", key).update(input, "utf8").digest();

/** AWS' URI-encode: RFC 3986 unreserved characters pass through untouched. */
const awsEncode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A path is encoded per segment so `/` survives as a separator. */
const awsEncodePath = (pathname: string): string =>
  pathname.split("/").map(awsEncode).join("/");

export interface SignV4Options {
  method: string;
  /** Absolute URL. A query string, when present, is part of the signature. */
  url: string;
  /** Extra headers to send and sign (e.g. content-type). Keys lowercase. */
  headers?: Record<string, string>;
  body?: string;
  accessKey: string;
  secretKey: string;
  /** Present for temp credentials; sent and signed as x-amz-security-token. */
  sessionToken?: string;
  region: string;
  service: string;
  /** Injectable clock; defaults to the real time. */
  now?: Date;
}

export interface SignV4Result {
  url: string;
  /** All headers the request must carry, including host/authorization. */
  headers: Record<string, string>;
}

/**
 * Sign a request and return the full header set to send it with. The caller
 * issues the fetch; this function only computes the signature.
 */
export function signV4(opts: SignV4Options): SignV4Result {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);

  const url = new URL(opts.url);
  const canonicalURI = awsEncodePath(url.pathname === "" ? "/" : url.pathname) || "/";
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => `${awsEncode(k)}=${awsEncode(v)}`)
    .sort()
    .join("&");

  const payloadHash = sha256Hex(opts.body ?? "");

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(opts.sessionToken ? { "x-amz-security-token": opts.sessionToken } : {}),
    ...opts.headers,
  };
  const sorted = Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = sorted.map(([k]) => k).join(";");
  const canonicalHeaders = sorted.map(([k, v]) => `${k}:${v.trim().replace(/\s+/g, " ")}\n`).join("");

  const canonicalRequest = [
    opts.method.toUpperCase(),
    canonicalURI,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(Buffer.from(`AWS4${opts.secretKey}`, "utf8"), dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url: opts.url, headers };
}
