import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuestAgentApp } from "@ori/guest-agent/app";
import { Restic, oriRepoUrl, snapshotRepoPassword } from "@ori/api/snapshots/restic";
import {
  computeSnapshotFingerprint,
  diffEtc,
  readLastFingerprint,
  redactSecrets,
  runSnapshot,
  writeLastFingerprint,
  type RunSnapshotInput,
  type SnapshotStorageConfig,
} from "@ori/guest-agent/snapshot";

/**
 * Bun's default per-test timeout is 5s, which is right for a unit test and wrong for a test
 * that runs a real `restic backup` against a real minio. On an idle machine those finish well
 * inside 5s; under load -- a parallel image build, another suite, anything -- they do not, and
 * the file went red roughly one run in three with "this test timed out after 5000ms". The
 * failures then cascaded, because the tests after the first assert on the snapshot it was
 * supposed to have created.
 *
 * This is a budget for real network I/O, not a performance assertion. The product's own cap on
 * a restic command is 60s (RESTIC_TIMEOUT_MS) and that is what actually bounds a hung backup.
 */
const REAL_IO_TIMEOUT_MS = 60_000;

/**
 * T-P5-03 — POST /snapshot, against the REAL local minio and REAL restic.
 *
 * The guest is exercised exactly the way the control plane will call it: the
 * storage credentials (T-P5-02) travel in the request body, the guest backs up
 * the work dir + (absent) volumes + a sysdiff.tar, and the repo is then read
 * back with the wrapper to prove the snapshot, the tree, and the sysdiff are
 * genuinely there. Skipped (not failed) when restic or minio is missing; each
 * run uses its own repo prefix so concurrent runs cannot collide.
 */
const ORI_ID = "or_abcdef12";
const AGENT_TOKEN = "ori_at_secret_token";
const S3 = {
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
  secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
  bucket: process.env.S3_BUCKET ?? "ori-snapshots",
};
const BIN = process.env.RESTIC_BIN ?? "restic";
const SERVER_SECRET = process.env.ORI_SNAPSHOT_SECRET ?? "test-dev-secret";

async function resticAvailable(): Promise<boolean> {
  try {
    const p = Bun.spawn({ cmd: [BIN, "version"], stdout: "pipe", stderr: "pipe" });
    await new Response(p.stdout).text();
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

async function minioAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${S3.endpoint.replace(/\/+$/, "")}/minio/health/live`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const SKIP = !(await resticAvailable()) || !(await minioAvailable());

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Read tar entry names out of a tar blob (ustar/pax; "./"-prefixed names stripped). */
function tarEntryNames(bytes: Uint8Array): string[] {
  const dec = new TextDecoder("latin1");
  const names: string[] = [];
  let off = 0;
  while (off + 512 <= bytes.length) {
    const block = bytes.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break; // end-of-archive zero block
    const name = dec.decode(block.subarray(0, 100)).split("\0")[0].replace(/^\.\//, "");
    const size = parseInt(dec.decode(block.subarray(124, 136)).trim(), 8) || 0;
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe.skipIf(SKIP)("T-P5-03 POST /snapshot (real minio + restic)", () => {
  const repoPrefix = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  let workDir = "";
  let app: ReturnType<typeof createGuestAgentApp>;
  let reader: Restic;
  let firstId = "";
  let secondId = "";

  /** The seeded work-dir payload sizes, for the "plausible sizeBytes" check. */
  const SEEDED_BYTES = Buffer.byteLength("hello snapshot ünïcode\n") + 6 + Buffer.byteLength("nested\n");

  function storage(over: Partial<SnapshotStorageConfig> = {}): SnapshotStorageConfig {
    return {
      repoUrl: oriRepoUrl(S3.endpoint, S3.bucket, repoPrefix),
      endpoint: S3.endpoint,
      bucket: S3.bucket,
      prefix: `oris/${repoPrefix}/`,
      region: "us-east-1",
      password: snapshotRepoPassword(repoPrefix, SERVER_SECRET),
      credentials: { accessKeyId: S3.accessKey, secretAccessKey: S3.secretKey, sessionToken: "" },
      ...over,
    };
  }

  async function postSnapshot(body: unknown, token = AGENT_TOKEN) {
    return app.request("/snapshot", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function postSnapshotJson(body: unknown, token = AGENT_TOKEN) {
    const res = await postSnapshot(body, token);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ori-ga-snap-"));
    await mkdir(join(workDir, "dir"), { recursive: true });
    await writeFile(join(workDir, "hello.txt"), "hello snapshot ünïcode\n");
    await writeFile(join(workDir, "dir", "blob.bin"), Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80, 0x7f]));
    await writeFile(join(workDir, "dir", "deep.txt"), "nested\n");

    // volumesDir + baseline manifest pointed at paths that do NOT exist: proves
    // both are skipped silently instead of failing the call.
    app = createGuestAgentApp({
      oriId: ORI_ID,
      agentToken: AGENT_TOKEN,
      workDir,
      volumesDir: join(tmpdir(), `ori-absent-vol-${repoPrefix}`),
      etcBaselinePath: join(tmpdir(), `ori-no-baseline-${repoPrefix}.json`),
    });

    reader = new Restic({
      bin: BIN,
      repo: oriRepoUrl(S3.endpoint, S3.bucket, repoPrefix),
      password: snapshotRepoPassword(repoPrefix, SERVER_SECRET),
      s3: { endpoint: S3.endpoint, accessKey: S3.accessKey, secretKey: S3.secretKey, region: "us-east-1" },
    });
  });

  afterAll(async () => {
    await reader?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  test("a backup of a seeded work dir reports a plausible fileCount and sizeBytes", async () => {
    const { status, body } = await postSnapshotJson({ mode: "auto", storage: storage() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.type).toBe("snapshot.created");
    expect(body.mode).toBe("auto");
    expect(body.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    // 3 seeded files + the sysdiff.tar itself, and every seeded byte captured.
    expect(body.fileCount).toBeGreaterThanOrEqual(4);
    expect(body.sizeBytes).toBeGreaterThanOrEqual(SEEDED_BYTES);
    expect(typeof body.createdAt).toBe("string");
    firstId = body.snapshotId as string;
  }, REAL_IO_TIMEOUT_MS);

  test("the snapshot is listable in the repo afterwards", async () => {
    const snaps = await reader.snapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].id).toBe(firstId);
    expect(snaps[0].parent).toBeNull();

    const paths = (await reader.ls(firstId)).map((n) => n.path);
    expect(paths.some((p) => p.endsWith("hello.txt"))).toBe(true);
    expect(paths.some((p) => p.endsWith("dir/blob.bin"))).toBe(true);
    expect(paths.some((p) => p.endsWith("dir/deep.txt"))).toBe(true);
    expect(paths.some((p) => p.endsWith(`ori-sysdiff-${ORI_ID}.tar`))).toBe(true);
  }, REAL_IO_TIMEOUT_MS);

  test("the sysdiff file is present inside the backup and holds the system delta", async () => {
    const sysdiffNode = (await reader.ls(firstId)).find(
      (n) => n.kind === "file" && n.path.endsWith(`ori-sysdiff-${ORI_ID}.tar`),
    );
    expect(sysdiffNode).toBeDefined();

    const names = tarEntryNames(await reader.dumpBytes(firstId, (sysdiffNode as { path: string }).path));
    for (const expected of [
      "manifest.txt",
      "dpkg-selections.txt",
      "enabled-units.txt",
      "etc-diff.json",
      "crontabs.txt",
    ]) {
      expect(names).toContain(expected);
    }

    // the sysdiff itself must not smuggle machine identity into the snapshot
    const serialized = names.join("\n");
    expect(serialized).not.toContain("machine-id");
    expect(serialized).not.toContain("ssh_host");
    expect(serialized).not.toContain("hostname");
  }, REAL_IO_TIMEOUT_MS);

  test("a second backup produces a second snapshot (incremental, with a parent)", async () => {
    await writeFile(join(workDir, "hello.txt"), "hello snapshot ünïcode — CHANGED\n");
    const { status, body } = await postSnapshotJson({ mode: "auto", storage: storage() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.type).toBe("snapshot.created");
    expect(body.snapshotId).not.toBe(firstId);
    secondId = body.snapshotId as string;

    const snaps = await reader.snapshots();
    expect(snaps).toHaveLength(2);
    expect(snaps.find((s) => s.id === secondId)?.parent).toBe(firstId);
  }, REAL_IO_TIMEOUT_MS);

  test("absent /var/lib/docker/volumes does not fail the call", async () => {
    // The app's volumesDir points at a path that does not exist, so every
    // snapshot here already exercises the silent skip; this one asserts the
    // tree really contains no volumes subtree.
    const { status, body } = await postSnapshotJson({ mode: "auto", storage: storage() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const paths = (await reader.ls(body.snapshotId as string)).map((n) => n.path);
    expect(paths.some((p) => p.includes("volumes"))).toBe(false);
  }, REAL_IO_TIMEOUT_MS);

  test("an unchanged tree is skipped; a changed tree snapshots (change detection)", async () => {
    // runSnapshot directly (not via the app) so the fingerprint path and every
    // probe source are hermetic temp dirs: the default /var/lib/ori path is not
    // writable on a dev host and the default /etc is the real one.
    const wd = await mkdtemp(join(tmpdir(), "ori-ga-cd-"));
    const fp = join(tmpdir(), `ori-fp-${repoPrefix}`);
    const etcRoot = await mkdtemp(join(tmpdir(), "ori-ga-etc-"));
    const absent = (name: string) => join(tmpdir(), `${name}-${repoPrefix}`);
    const input: RunSnapshotInput = {
      oriId: ORI_ID,
      mode: "auto",
      storage: storage(),
      workDir: wd,
      fingerprintPath: fp,
      etcRoot,
      dpkgStatusFile: absent("ori-no-dpkg"),
      crontabSpoolDir: absent("ori-no-cron"),
      etcBaselinePath: absent("ori-no-baseline.json"),
    };
    try {
      await writeFile(join(wd, "file.txt"), "v1\n");
      const first = await runSnapshot(input);
      expect(first.type).toBe("snapshot.created");
      const second = await runSnapshot(input);
      expect(second.type).toBe("snapshot.skipped");
      if (second.type === "snapshot.skipped") expect(second.reason.length).toBeGreaterThan(0);

      // Longer content, not just different content. On a filesystem with 1-second mtime
      // granularity a same-length rewrite inside the same second moves nothing the probe looks
      // at, and this test would flake on the skip it is trying to disprove. The unit tests pin
      // mtimes with utimes for the same reason; here changing the size is the smaller lever.
      await writeFile(join(wd, "file.txt"), "v2 — and enough extra bytes to change the size\n");
      const third = await runSnapshot(input);
      expect(third.type).toBe("snapshot.created");
      if (third.type === "snapshot.created" && first.type === "snapshot.created") {
        expect(third.snapshotId).not.toBe(first.snapshotId);
      }

      // A `final` snapshot never skips, however unchanged the tree is: stopOri destroys the
      // container as soon as this reports success, so it is the one snapshot that must be real.
      const fourth = await runSnapshot({ ...input, mode: "final" });
      expect(fourth.type).toBe("snapshot.created");
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(fp, { force: true });
      await rm(etcRoot, { recursive: true, force: true });
    }
  }, REAL_IO_TIMEOUT_MS);

  test("a seeded /var/lib/docker/volumes IS backed up", async () => {
    const volRoot = await mkdtemp(join(tmpdir(), "ori-vol-root-"));
    try {
      await mkdir(join(volRoot, "vol1", "_data"), { recursive: true });
      await writeFile(join(volRoot, "vol1", "_data", "state.db"), "docker volume payload\n");

      const withVolumes = createGuestAgentApp({
        oriId: ORI_ID,
        agentToken: AGENT_TOKEN,
        workDir,
        volumesDir: volRoot,
        etcBaselinePath: join(tmpdir(), `ori-no-baseline-${repoPrefix}.json`),
      });
      const res = await withVolumes.request("/snapshot", {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "auto", storage: storage() }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);

      const paths = (await reader.ls(body.snapshotId as string)).map((n) => n.path);
      expect(paths.some((p) => p.endsWith("vol1/_data/state.db"))).toBe(true);
    } finally {
      await rm(volRoot, { recursive: true, force: true });
    }
  }, REAL_IO_TIMEOUT_MS);

  test(
    "a bad credential on a final snapshot is a clear failure, not a false success",
    async () => {
      // A dedicated app with a tight per-command cap: restic's S3 backend retries
      // a hard auth failure with its own (unpredictable, tens-of-seconds) backoff,
      // so the wrapper kill bounds it. The contract under test is the HONESTY of a
      // failed final snapshot, not restic's retry schedule.
      const badCredApp = createGuestAgentApp({
        oriId: ORI_ID,
        agentToken: AGENT_TOKEN,
        workDir,
        volumesDir: join(tmpdir(), `ori-absent-vol-${repoPrefix}`),
        etcBaselinePath: join(tmpdir(), `ori-no-baseline-${repoPrefix}.json`),
        resticTimeoutMs: 20_000,
      });
      const bad = storage({
        credentials: { accessKeyId: "ori_snapshot_bad_key", secretAccessKey: "ori_snapshot_bad_secret", sessionToken: "" },
      });
      const before = (await reader.snapshots()).length;

      const res = await badCredApp.request("/snapshot", {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "final", storage: bad }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
      expect((body.error as string).length).toBeGreaterThan(0);
      expect(body.snapshotId).toBeUndefined();

      // and it did not sneak a partial/empty snapshot into the repo
      expect((await reader.snapshots()).length).toBe(before);

      // the repo password / S3 secret never echo back in the error
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("ori_snapshot_bad_key");
      expect(serialized).not.toContain("ori_snapshot_bad_secret");
    },
    60_000,
  );
});

describe("T-P5-03 POST /snapshot validation (no minio/restic needed)", () => {
  const app = createGuestAgentApp({ oriId: ORI_ID, agentToken: AGENT_TOKEN });
  const SAMPLE_STORAGE: SnapshotStorageConfig = {
    repoUrl: "s3:http://localhost:9000/ori-snapshots/oris/or_abcdef12",
    endpoint: "http://localhost:9000",
    bucket: "ori-snapshots",
    prefix: "oris/or_abcdef12/",
    password: "pw",
    credentials: { accessKeyId: "k", secretAccessKey: "s", sessionToken: "" },
  };

  async function post(body: unknown) {
    return app.request("/snapshot", {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("rejects a mode other than auto|final", async () => {
    expect((await post({ mode: "never", storage: SAMPLE_STORAGE })).status).toBe(400);
  });

  test("requires storage", async () => {
    expect((await post({ mode: "auto" })).status).toBe(400);
  });

  test("requires a repo password in storage", async () => {
    expect((await post({ mode: "auto", storage: { ...SAMPLE_STORAGE, password: "" } })).status).toBe(400);
  });

  test("requires credentials", async () => {
    expect(
      (await post({ mode: "auto", storage: { ...SAMPLE_STORAGE, credentials: undefined } })).status,
    ).toBe(400);
  });

  test("requires auth", async () => {
    const res = await app.request("/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "auto", storage: SAMPLE_STORAGE }),
    });
    expect(res.status).toBe(401);
  });
});

describe("T-P5-03 /etc diff excludes machine identity + redaction (no minio/restic needed)", () => {
  test("ssh host keys, machine-id, hostname and hosts never reach the diff", async () => {
    const live = await mkdtemp(join(tmpdir(), "ori-etc-live-"));
    const base = await mkdtemp(join(tmpdir(), "ori-etc-base-"));
    try {
      await mkdir(join(live, "ssh"), { recursive: true });
      await mkdir(join(live, "systemd"), { recursive: true });
      await writeFile(join(live, "ssh", "ssh_host_ed25519_key"), "per-ori key");
      await writeFile(join(live, "ssh", "ssh_host_ed25519_key.pub"), "per-ori pub");
      await writeFile(join(live, "machine-id"), "per-ori machine id");
      await writeFile(join(live, "hostname"), "or_abcdef12");
      await writeFile(join(live, "hosts"), "127.0.0.1 localhost");
      await writeFile(join(live, "systemd", "logind.conf"), "user-touched");
      await writeFile(join(live, "passwd"), "user-added-user");

      // A baseline that also (impossibly, at build time) recorded identity files:
      // the exclusion must hold even then, not only for files absent from it.
      const baselinePath = join(base, "etc-manifest.json");
      await writeFile(
        baselinePath,
        JSON.stringify({
          version: 1,
          files: {
            "/etc/systemd/logind.conf": { sha256: sha("baseline logind") },
            "/etc/passwd": { sha256: sha("baseline passwd") },
            "/etc/hostname": { sha256: sha("baseline hostname") },
            "/etc/hosts": { sha256: sha("baseline hosts") },
            "/etc/machine-id": { sha256: sha("") },
            "/etc/ssh/ssh_host_ed25519_key": { sha256: sha("baseline key") },
          },
          symlinks: {},
          dirs: [],
        }),
      );

      const out = join(base, "out");
      const diff = await diffEtc(live, baselinePath, out);

      expect(diff.changed).toEqual(expect.arrayContaining(["/etc/systemd/logind.conf", "/etc/passwd"]));
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.skipped).toEqual(
        expect.arrayContaining([
          "/etc/ssh/ssh_host_ed25519_key",
          "/etc/ssh/ssh_host_ed25519_key.pub",
          "/etc/machine-id",
          "/etc/hostname",
          "/etc/hosts",
        ]),
      );

      // the identity paths are listed as skipped but their CONTENT is not stored
      const names = (await readdir(out, { recursive: true })).map(String).join("\n");
      expect(names).toContain("systemd/logind.conf");
      expect(names).toContain("passwd");
      expect(names).not.toContain("machine-id");
      expect(names).not.toContain("ssh_host");
      expect(names).not.toContain("hostname");
      expect(names).not.toContain("/etc/hosts");
    } finally {
      await rm(live, { recursive: true, force: true });
      await rm(base, { recursive: true, force: true });
    }
  }, REAL_IO_TIMEOUT_MS);

  test("a missing baseline manifest degrades to noBaseline, never a failure", async () => {
    const live = await mkdtemp(join(tmpdir(), "ori-etc-live2-"));
    const base = await mkdtemp(join(tmpdir(), "ori-etc-base2-"));
    try {
      const diff = await diffEtc(live, join(base, "missing.json"), join(base, "out"));
      expect(diff.noBaseline).toBe(true);
      expect(diff.changed).toEqual([]);
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.skipped).toEqual([]);
    } finally {
      await rm(live, { recursive: true, force: true });
      await rm(base, { recursive: true, force: true });
    }
  });

  test("redactSecrets strips the repo password and every S3 credential string", () => {
    const storageCfg: SnapshotStorageConfig = {
      repoUrl: "s3:http://localhost:9000/b/oris/or_test",
      endpoint: "http://localhost:9000",
      bucket: "b",
      prefix: "oris/or_test/",
      password: "hunter2-repo-pass",
      credentials: { accessKeyId: "AKID123", secretAccessKey: "SKRETE", sessionToken: "STOKEN" },
    };
    const out = redactSecrets(
      storageCfg,
      `pass=${storageCfg.password} key=${storageCfg.credentials.accessKeyId} ` +
        `sec=${storageCfg.credentials.secretAccessKey} tok=${storageCfg.credentials.sessionToken}`,
    );
    expect(out).not.toContain("hunter2-repo-pass");
    expect(out).not.toContain("AKID123");
    expect(out).not.toContain("SKRETE");
    expect(out).not.toContain("STOKEN");
    expect(out).toContain("<redacted>");
  });
});

describe("T-P5-03 change-detection fingerprint (no minio/restic needed)", () => {
  const absent = (name: string) => join(tmpdir(), `${name}-${Math.random().toString(36).slice(2, 8)}`);

  test("the probe changes when a tracked source changes and is stable when nothing does", async () => {
    const work = await mkdtemp(join(tmpdir(), "ori-fp-work-"));
    const etc = await mkdtemp(join(tmpdir(), "ori-fp-etc-"));
    const dpkg = join(etc, "dpkg-status");
    const volumes = join(etc, "absent-volumes");
    try {
      // Distinct, explicit mtimes: back-to-back writeFile calls can share a
      // millisecond, which would make the probe legitimately (but annoyingly)
      // equal across steps. utimes pins each change to its own epoch ms.
      const at = (p: string, ms: number) => utimes(p, new Date(ms), new Date(ms));
      await writeFile(join(work, "a.txt"), "x");
      await at(join(work, "a.txt"), 1_000);
      await writeFile(join(etc, "conf"), "y");
      await at(join(etc, "conf"), 2_000);
      const base = await computeSnapshotFingerprint({
        workDir: work,
        volumesDir: volumes,
        etcRoot: etc,
        dpkgStatusFile: dpkg,
      });
      // an identical machine state produces an identical probe — this is what makes a skip safe
      const again = await computeSnapshotFingerprint({
        workDir: work,
        volumesDir: volumes,
        etcRoot: etc,
        dpkgStatusFile: dpkg,
      });
      expect(again).toBe(base);

      // a work-dir content edit moves the probe
      await writeFile(join(work, "a.txt"), "x2");
      await at(join(work, "a.txt"), 3_000);
      const afterWork = await computeSnapshotFingerprint({
        workDir: work,
        volumesDir: volumes,
        etcRoot: etc,
        dpkgStatusFile: dpkg,
      });
      expect(afterWork).not.toBe(base);

      // an /etc edit moves it too
      await writeFile(join(etc, "conf"), "y2");
      await at(join(etc, "conf"), 4_000);
      const afterEtc = await computeSnapshotFingerprint({
        workDir: work,
        volumesDir: volumes,
        etcRoot: etc,
        dpkgStatusFile: dpkg,
      });
      expect(afterEtc).not.toBe(afterWork);

      // a dpkg status edit moves it
      await writeFile(dpkg, "s");
      await at(dpkg, 5_000);
      const afterDpkg = await computeSnapshotFingerprint({
        workDir: work,
        volumesDir: volumes,
        etcRoot: etc,
        dpkgStatusFile: dpkg,
      });
      expect(afterDpkg).not.toBe(afterEtc);
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(etc, { recursive: true, force: true });
    }
  });

  test("machine-identity files under /etc never move the probe", async () => {
    // Identity churn is the reason an otherwise idle ori looked "changed": the image
    // regenerates hostname/machine-id/ssh keys at boot. Excluding them from the sysdiff
    // is only half the fix — the probe must not snapshot because of them either.
    const etc = await mkdtemp(join(tmpdir(), "ori-fp-etc-"));
    // A separate, untouched work dir: the work-dir probe has no exclusion list, so it
    // must not share a tree with the identity files or it would move for the wrong reason.
    const work = await mkdtemp(join(tmpdir(), "ori-fp-work-"));
    try {
      const before = await computeSnapshotFingerprint({ workDir: work, volumesDir: absent("v"), etcRoot: etc });
      await writeFile(join(etc, "hostname"), "or_abcdef12");
      await mkdir(join(etc, "ssh"), { recursive: true });
      await writeFile(join(etc, "ssh", "ssh_host_ed25519_key"), "per-ori key");
      await writeFile(join(etc, "machine-id"), "per-ori machine id");
      const after = await computeSnapshotFingerprint({ workDir: work, volumesDir: absent("v"), etcRoot: etc });
      expect(after).toBe(before);
    } finally {
      await rm(etc, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  /*
   * The probe was max-mtime-only once, and this is the case that made it unsafe: `tar -x`,
   * `unzip`, `cp -p` and `rsync --times` all stamp restored files with the archive's own mtimes,
   * which are older than whatever is already newest in the tree. Extracting a tarball is the most
   * ordinary thing a person does in a sandbox, and under a max-only probe it left the fingerprint
   * identical — so the snapshot was skipped and the extracted work never reached the repo.
   */
  test("a file added with an OLD mtime still moves the probe (tar -x, unzip, cp -p)", async () => {
    const work = await mkdtemp(join(tmpdir(), "ori-fp-tar-"));
    try {
      await writeFile(join(work, "recent.txt"), "written just now");
      const before = await computeSnapshotFingerprint({ workDir: work, volumesDir: absent("v"), etcRoot: absent("e") });

      // Exactly what an extracted archive looks like: new content, mtime from 2023.
      const extracted = join(work, "from-archive.txt");
      await writeFile(extracted, "a whole project the user just unpacked");
      const old = new Date("2023-01-01T00:00:00Z");
      await utimes(extracted, old, old);

      const after = await computeSnapshotFingerprint({ workDir: work, volumesDir: absent("v"), etcRoot: absent("e") });
      expect(after).not.toBe(before);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("deleting a file that is not the newest still moves the probe", async () => {
    const work = await mkdtemp(join(tmpdir(), "ori-fp-del-"));
    try {
      const stale = join(work, "stale.txt");
      await writeFile(stale, "deleted later");
      const old = new Date("2023-01-01T00:00:00Z");
      await utimes(stale, old, old);
      await writeFile(join(work, "newest.txt"), "this one stays and stays newest");

      const before = await computeSnapshotFingerprint({ workDir: work, volumesDir: absent("v"), etcRoot: absent("e") });
      await rm(stale);
      const after = await computeSnapshotFingerprint({ workDir: work, volumesDir: absent("v"), etcRoot: absent("e") });

      // Under a max-only probe the maximum was untouched, so the deletion was invisible and a
      // resume resurrected the file.
      expect(after).not.toBe(before);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("writeLastFingerprint/readLastFingerprint round-trip and a missing file is null", async () => {
    const fp = join(tmpdir(), `ori-fp-file-${Math.random().toString(36).slice(2, 8)}`);
    await rm(fp, { force: true });
    try {
      expect(await readLastFingerprint(fp)).toBeNull();
      await writeLastFingerprint(fp, "v1:1:2:3:4:5");
      expect(await readLastFingerprint(fp)).toBe("v1:1:2:3:4:5");
    } finally {
      await rm(fp, { force: true });
    }
  });
});
