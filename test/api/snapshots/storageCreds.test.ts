import { describe, expect, test, beforeAll } from "bun:test";
import {
  STORAGE_CRED_TTL_SECONDS,
  oriStoragePrefix,
  mintOriStorageCredentials,
  storageConfigFromEnv,
  type OriStorageCredentials,
} from "@ori/api/snapshots/storageCreds";
import { signV4 } from "@ori/api/snapshots/sigv4";
import { oriId } from "@ori/contract";

// §5 SECURITY INVARIANT: a ori has sudo, so it can read anything we put inside it.
// Credentials handed to a ori must therefore be POWERLESS outside that ori's prefix.
//
// The point of this file is that the restriction is enforced by the OBJECT STORE, not by
// our code politely passing the right prefix. So every assertion below issues a real,
// signed S3 request with ori A's credentials and checks what minio actually does. A test
// that only inspected the policy JSON we generated would prove nothing: it would pass
// just as happily if minio ignored the policy entirely.
const config = storageConfigFromEnv();

async function minioUp(): Promise<boolean> {
  try {
    const res = await fetch(`${config.endpoint}/minio/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await minioUp();

/** Issue a signed S3 request with the given credentials. Returns the HTTP status. */
async function s3(
  creds: OriStorageCredentials,
  method: string,
  path: string,
  body?: string,
): Promise<number> {
  // Deliberately config.endpoint, NOT creds.endpoint. A credential's endpoint is the address
  // a ORI uses, which under Docker is host.docker.internal — correct for a container and
  // unresolvable from this test process. Signing against the host-reachable address changes
  // nothing about what is under test: the restriction lives in the credential's session
  // policy, and minio enforces it identically whichever hostname the request arrives on.
  // Using creds.endpoint made the whole file fail the moment S3_ENDPOINT_FOR_ORI was set —
  // which the README tells you to do.
  const url = `${config.endpoint}${path}`;
  const signed = signV4({
    method,
    url,
    body,
    accessKey: creds.accessKeyId,
    secretKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    region: creds.region,
    service: "s3",
  });
  const res = await fetch(signed.url, { method, headers: signed.headers, body });
  // Drain so the connection is reusable and bun does not warn.
  await res.arrayBuffer();
  return res.status;
}

describe.skipIf(!up)("T-P5-02 storage credentials are scoped by the object store", () => {
  const oriA = oriId();
  const oriB = oriId();
  let credsA: OriStorageCredentials;

  beforeAll(async () => {
    credsA = await mintOriStorageCredentials(config, oriA);
  });

  test("ori A can write and read inside its OWN prefix", async () => {
    // Asserted first and deliberately: without it, every denial below could be satisfied
    // by handing out credentials that are simply broken for everything.
    const key = `/${config.bucket}/${oriStoragePrefix(oriA)}own.txt`;
    expect(await s3(credsA, "PUT", key, "mine")).toBe(200);
    expect(await s3(credsA, "GET", key)).toBe(200);
  });

  test("ori A CANNOT read ori B's prefix", async () => {
    const status = await s3(credsA, "GET", `/${config.bucket}/${oriStoragePrefix(oriB)}secret.txt`);
    // 403 denied. NOT 404: a 404 would mean the credential was allowed to look and simply
    // found nothing, which is a different and much weaker guarantee.
    expect(status).toBe(403);
  });

  test("ori A CANNOT write into ori B's prefix", async () => {
    const status = await s3(credsA, "PUT", `/${config.bucket}/${oriStoragePrefix(oriB)}pwned.txt`, "x");
    expect(status).toBe(403);
  });

  test("ori A CANNOT delete from ori B's prefix", async () => {
    const status = await s3(credsA, "DELETE", `/${config.bucket}/${oriStoragePrefix(oriB)}own.txt`);
    expect(status).toBe(403);
  });

  test("ori A CANNOT list ori B's prefix", async () => {
    // ListBucket is granted on the bucket but conditioned on s3:prefix, so listing
    // someone else's prefix must fail. Without the condition a ori could enumerate every
    // other ori's object keys — the ids leak even if the bytes do not.
    const q = `?list-type=2&prefix=${encodeURIComponent(oriStoragePrefix(oriB))}`;
    expect(await s3(credsA, "GET", `/${config.bucket}${q}`)).toBe(403);
  });

  test("ori A CANNOT list the whole bucket", async () => {
    expect(await s3(credsA, "GET", `/${config.bucket}?list-type=2`)).toBe(403);
  });

  test("ori A CAN list its own prefix", async () => {
    const q = `?list-type=2&prefix=${encodeURIComponent(oriStoragePrefix(oriA))}`;
    expect(await s3(credsA, "GET", `/${config.bucket}${q}`)).toBe(200);
  });

  test("credentials expire within an hour", async () => {
    const ttlMs = credsA.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(STORAGE_CRED_TTL_SECONDS * 1000 + 60_000);
    expect(credsA.durationSeconds).toBeLessThanOrEqual(STORAGE_CRED_TTL_SECONDS);
  });

  test("the repo url and prefix name this ori and no other", () => {
    expect(credsA.prefix).toBe(`oris/${oriA}/`);
    expect(credsA.repoUrl).toContain(`/oris/${oriA}`);
    expect(credsA.repoUrl).not.toContain(oriB);
  });

  test("a second ori gets a credential powerless against the first", async () => {
    // The mirror image, so the scoping cannot be an artefact of who was minted first.
    const credsB = await mintOriStorageCredentials(config, oriB);
    expect(await s3(credsB, "GET", `/${config.bucket}${oriStoragePrefix(oriA)}own.txt`)).not.toBe(200);
    expect(await s3(credsB, "GET", `/${config.bucket}/${oriStoragePrefix(oriA)}own.txt`)).toBe(403);
  });

  test("a read-only credential for a prefix can READ it but cannot WRITE or DELETE (fork-restore)", async () => {
    // Cross-ori fork-restore: the fork is minted read-only credentials scoped to the
    // PARENT's prefix (OPEN-DECISIONS #2). It must be able to read the parent's repo
    // objects (that is the entire point) while being structurally unable to corrupt them.
    const readOnly = await mintOriStorageCredentials(config, oriA, { readOnly: true });
    expect(readOnly.readOnly).toBe(true);

    const key = `/${config.bucket}/${oriStoragePrefix(oriA)}own.txt`;
    expect(await s3(readOnly, "GET", key)).toBe(200);
    const listQ = `?list-type=2&prefix=${encodeURIComponent(oriStoragePrefix(oriA))}`;
    expect(await s3(readOnly, "GET", `/${config.bucket}${listQ}`)).toBe(200);
    expect(await s3(readOnly, "PUT", `/${config.bucket}/${oriStoragePrefix(oriA)}ro-write.txt`, "x")).toBe(403);
    expect(await s3(readOnly, "DELETE", key)).toBe(403);
  });

  test("a default credential stays read-write and readOnly is false", async () => {
    const rw = await mintOriStorageCredentials(config, oriB);
    expect(rw.readOnly).toBe(false);
    // Sanity anchor: the default path still has put/delete, so the narrowing above is
    // attributable to readOnly and not to a policy bug that broke everything.
    const key = `/${config.bucket}/${oriStoragePrefix(oriB)}rw.txt`;
    expect(await s3(rw, "PUT", key, "x")).toBe(200);
    // MinIO answers a successful DELETE with 204 No Content, not 200.
    expect(await s3(rw, "DELETE", key)).toBe(204);
  });
});

describe("T-P5-02 prefix derivation", () => {
  test("a prefix is oris/<id>/ and cannot be escaped by the id", () => {
    const id = oriId();
    expect(oriStoragePrefix(id)).toBe(`oris/${id}/`);
    // Ori ids are ^or_[23456789abcdefghjkmnpqrstuvwxyz]{8}$, so no separator or traversal
    // character can appear in one. Assert it, because the prefix is concatenated into an
    // ARN and a policy: an id containing / or * would widen the grant.
    expect(id).toMatch(/^or_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
    expect(oriStoragePrefix(id)).not.toContain("*");
    expect(oriStoragePrefix(id)).not.toContain("..");
  });
});
