/**
 * Delete every object a ori has in the snapshot store.
 *
 * This is the only code in the system that destroys snapshot data, and it exists because
 * `stop` deliberately does not: an archived ori keeps its restic repository forever so a
 * resume or a fork can still restore from it. Deleting the ori is the one moment the bytes
 * should go too, otherwise a bucket only ever grows.
 *
 * It talks to S3 directly rather than through restic. `restic forget --prune` removes
 * snapshots from a repository but leaves the repository (config, keys, index) behind, and a
 * repository with no snapshots is still an object that costs money and confuses an operator
 * reading the bucket. The prefix is the unit of ownership here — `oris/<oriId>/` is exactly
 * what the ori's own scoped credentials could ever write to — so removing the prefix removes
 * precisely this ori's data and nothing else.
 */
import { signV4 } from "./sigv4";
import { oriStoragePrefix, type StorageConfig } from "./storageCreds";

export interface PurgeResult {
  /** Objects actually deleted. Zero is normal: a ori that never snapshotted has no prefix. */
  deleted: number;
  /** Keys the store refused to delete, with its reason. Non-empty means data was left behind. */
  failed: { key: string; status: number }[];
}

function s3Fetch(cfg: StorageConfig, method: string, path: string, query: Record<string, string>) {
  const url = new URL(`${cfg.endpoint.replace(/\/+$/, "")}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const signed = signV4({
    method,
    url: url.toString(),
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    region: cfg.region ?? "us-east-1",
    service: "s3",
  });
  return fetch(signed.url, { method, headers: signed.headers });
}

/**
 * List every key under a prefix, following continuation tokens.
 *
 * ponytail: one page at a time rather than parallel prefix scans. A ori's repository is
 * hundreds to thousands of objects, not millions; if that stops being true, batch the deletes
 * with the S3 multi-object DeleteObjects POST instead of widening this.
 */
async function listKeys(cfg: StorageConfig, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;

  do {
    const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
    if (token) query["continuation-token"] = token;

    const res = await s3Fetch(cfg, "GET", `/${cfg.bucket}`, query);
    if (!res.ok) {
      // A missing bucket means nothing to purge, which is not a failure.
      if (res.status === 404) return keys;
      throw new Error(`list ${prefix} failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.text();
    for (const m of body.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const key = m[1];
      if (key) keys.push(decodeXml(key));
    }

    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(body);
    token = truncated ? body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : undefined;
    if (truncated && !token) throw new Error(`list ${prefix} truncated without a continuation token`);
  } while (token);

  return keys;
}

/** The five entities S3 escapes in the XML it returns. Keys legitimately contain `&`. */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Remove every object under `oris/<oriId>/`.
 *
 * Reports what it could not delete rather than throwing on the first refusal: a caller
 * deleting a ori wants the database row gone even if the object store is having a bad day,
 * and wants to be told which bytes survived.
 */
export async function purgeOriSnapshots(cfg: StorageConfig, oriId: string): Promise<PurgeResult> {
  const prefix = oriStoragePrefix(oriId);
  const keys = await listKeys(cfg, prefix);
  const failed: PurgeResult["failed"] = [];
  let deleted = 0;

  for (const key of keys) {
    const res = await s3Fetch(cfg, "DELETE", `/${cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`, {});
    // S3 answers 204 for a delete, and also for a key that was already gone.
    if (res.ok || res.status === 404) deleted++;
    else failed.push({ key, status: res.status });
  }

  return { deleted, failed };
}
