import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Restic,
  legacySnapshotRepoPassword,
  oriRepoUrl,
  resolveRepoPassword,
  snapshotRepoPassword,
  snapshotRepoPasswords,
} from "@ori/api/snapshots/restic";

/**
 * T-P5-01 — the restic wrapper, against the REAL local minio.
 *
 * The wrapper is exercised the way the control plane and the guest agent will:
 * init, backup with tags, snapshots, ls, dump (file byte-exact + folder as tar),
 * restore, an incremental backup with a visible parent chain, and forget. No
 * mocks, no fake S3 — a skipped test tells you the environment is missing, it
 * never pretends the wrapper works.
 *
 * The whole block is skipped (not failed) when restic is missing or minio is
 * down, so `make verify` stays green on a machine without either. Each run uses
 * its own repo prefix under the shared bucket so concurrent runs cannot collide.
 *
 * VERSION SKEW (see restic.ts): this test drives the HOST restic (brew, 0.19.x
 * on this machine); the ori's own copy is 0.16.4 from the distro. The repo
 * format is compatible, and the wrapper sticks to long-stable flags.
 */

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
    return false; // Bun.spawn throws synchronously when the binary does not exist
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

/** Walk a dir tree to {relative path: bytes} for a content comparison. */
async function listRel(root: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  async function walk(dir: string, rel: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, r);
      else out[r] = new Uint8Array(await readFile(full));
    }
  }
  await walk(root, "");
  return out;
}

/** Minimal tar reader: entry names only (name in bytes 0-100, size octal in 124-135). */
function tarEntryNames(bytes: Uint8Array): string[] {
  const dec = new TextDecoder("latin1");
  const names: string[] = [];
  let off = 0;
  while (off + 512 <= bytes.length) {
    const block = bytes.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break; // end-of-archive zero block
    const name = dec.decode(block.subarray(0, 100)).split("\0")[0];
    const size = parseInt(dec.decode(block.subarray(124, 136)).trim(), 8) || 0;
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe.skipIf(SKIP)("T-P5-01 restic wrapper (real minio)", () => {
  // Unique per run: oriId() alone is only 8 chars, so add a time+random suffix.
  const repoPrefix = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  let restic: Restic;
  let srcDir: string;
  let firstId: string;
  let secondId: string;

  beforeAll(async () => {
    srcDir = await mkdtemp(join(tmpdir(), "ori-snap-src-"));
    await mkdir(join(srcDir, "dir"), { recursive: true });
    await writeFile(join(srcDir, "file.txt"), "hello restic ünïcode\n");
    await writeFile(join(srcDir, "dir", "blob.bin"), Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80, 0x7f]));
    await writeFile(join(srcDir, "dir", "deep.txt"), "nested\n");

    restic = new Restic({
      bin: BIN,
      repo: oriRepoUrl(S3.endpoint, S3.bucket, repoPrefix),
      password: snapshotRepoPassword(repoPrefix, SERVER_SECRET),
      s3: S3,
    });
  });

  afterAll(async () => {
    await restic?.close();
    await rm(srcDir, { recursive: true, force: true });
  });

  test("init creates a repository and a second init is a no-op", async () => {
    await restic.init();
    await restic.init(); // idempotent: must not throw
    await expect(restic.snapshots()).resolves.toEqual([]);
  });

  test("backup with tags stores the tree", async () => {
    const r = await restic.backup([srcDir], { tags: ["tag-a", "env=prod"] });
    expect(r.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(r.summary.totalFilesProcessed).toBeGreaterThanOrEqual(3);
    firstId = r.snapshotId;
  });

  test("snapshots lists the backup with its tags", async () => {
    const snaps = await restic.snapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].id).toBe(firstId);
    expect(snaps[0].paths).toContain(srcDir);
    expect(snaps[0].tags).toEqual(expect.arrayContaining(["tag-a", "env=prod"]));
    expect(snaps[0].parent).toBeNull();
  });

  test("ls lists the tree with kinds and sizes", async () => {
    const nodes = await restic.ls(firstId);
    const files = nodes.filter((n) => n.kind === "file");
    expect(files.some((n) => n.path.endsWith("file.txt"))).toBe(true);
    const blob = files.find((n) => n.path.endsWith("blob.bin"));
    expect(blob?.size).toBe(6);
    expect(nodes.some((n) => n.kind === "dir" && n.path.endsWith("dir"))).toBe(true);
  });

  test("dump a single text file byte-exact", async () => {
    const bytes = await restic.dumpBytes(firstId, join(srcDir, "file.txt"));
    expect(Buffer.from(bytes).toString("utf8")).toBe("hello restic ünïcode\n");
  });

  test("dump a binary file byte-exact", async () => {
    const bytes = await restic.dumpBytes(firstId, join(srcDir, "dir", "blob.bin"));
    expect(Array.from(bytes)).toEqual([0x00, 0x01, 0xfe, 0xff, 0x80, 0x7f]);
  });

  test("dump a folder streams a tar with every entry", async () => {
    const bytes = await restic.dumpBytes(firstId, srcDir);
    const names = tarEntryNames(bytes);
    expect(names.some((n) => n.endsWith("dir/"))).toBe(true);
    expect(names.some((n) => n.endsWith("dir/blob.bin"))).toBe(true);
    expect(names.some((n) => n.endsWith("dir/deep.txt"))).toBe(true);
    expect(names.some((n) => n.endsWith("file.txt"))).toBe(true);
  });

  test("restore into a fresh dir reproduces the tree byte-for-byte", async () => {
    const tgt = await mkdtemp(join(tmpdir(), "ori-snap-tgt-"));
    try {
      await restic.restore(firstId, tgt);
      // restic lays the snapshot out under the full absolute source path.
      expect(await listRel(join(tgt, srcDir))).toEqual(await listRel(srcDir));
    } finally {
      await rm(tgt, { recursive: true, force: true });
    }
  });

  test("a changed tree backs up incrementally and both snapshots are listed", async () => {
    await writeFile(join(srcDir, "file.txt"), "hello restic ünïcode — CHANGED\n");
    const r = await restic.backup([srcDir]);
    secondId = r.snapshotId;
    expect(r.summary.filesChanged).toBe(1);
    expect(r.summary.filesUnmodified).toBeGreaterThanOrEqual(2);

    const snaps = await restic.snapshots();
    expect(snaps).toHaveLength(2);
    const newest = snaps.find((s) => s.id === secondId);
    const oldest = snaps.find((s) => s.id === firstId);
    expect(newest?.parent).toBe(firstId);
    expect(oldest?.parent).toBeNull();
  });

  test("forget --keep-last 1 leaves the newest snapshot", async () => {
    const res = await restic.forget({ keepLast: 1 });
    expect(res.removeIds).toContain(firstId.slice(0, 8));
    expect(res.keepIds).toContain(secondId.slice(0, 8));

    const snaps = await restic.snapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].id).toBe(secondId);
  });
});

describe("T-P5-01 snapshot repo password derivation (key id)", () => {
  const SECRET = "test-dev-secret";
  const ORID = "or_23456789";

  test("the current derivation carries the key-id prefix", () => {
    const pw = snapshotRepoPassword(ORID, SECRET);
    // v1 is the default KEY_ID; assert the full derivation is keyed, so a rotation
    // (KEY_ID=v2) provably changes the password.
    expect(pw).toBe(createHmacSha256(SECRET, `ori-snapshot-repo:v1:${ORID}`));
  });

  test("a different key id yields a different password", () => {
    const v1 = snapshotRepoPassword(ORID, SECRET, "v1");
    const v2 = snapshotRepoPassword(ORID, SECRET, "v2");
    expect(v1).not.toBe(v2);
  });

  test("the legacy un-prefixed derivation differs from the keyed one", () => {
    expect(legacySnapshotRepoPassword(ORID, SECRET)).toBe(createHmacSha256(SECRET, `ori-snapshot-repo:${ORID}`));
    expect(snapshotRepoPassword(ORID, SECRET)).not.toBe(legacySnapshotRepoPassword(ORID, SECRET));
  });

  test("snapshotRepoPasswords lists both candidates, current first", () => {
    const candidates = snapshotRepoPasswords(ORID, SECRET);
    expect(candidates).toEqual([snapshotRepoPassword(ORID, SECRET), legacySnapshotRepoPassword(ORID, SECRET)]);
  });
});

describe.skipIf(SKIP)("T-P5-01 repo password resolution (key id backward compatibility)", () => {
  // OPEN-DECISIONS #1: repos created BEFORE the key-id change used the un-prefixed
  // derivation and must keep opening. This drives real restic + minio: init a repo with
  // the LEGACY password, then resolveRepoPassword must pick the legacy derivation (the
  // keyed one would be rejected by restic), and the resolved password must restore data.
  const prefix = `pw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const repo = oriRepoUrl(S3.endpoint, S3.bucket, prefix);
  const legacy = legacySnapshotRepoPassword(prefix, SERVER_SECRET);
  const keyed = snapshotRepoPassword(prefix, SERVER_SECRET);

  test(
    "a repo created with the legacy password resolves to the legacy derivation",
    async () => {
      const legacyRestic = new Restic({ bin: BIN, repo, password: legacy, s3: S3 });
      await legacyRestic.init();
      await legacyRestic.close();

      // The keyed password must NOT open it (that is the whole point of the migration).
      const wrong = new Restic({ bin: BIN, repo, password: keyed, s3: S3 });
      expect(await wrong.probePassword()).toBe("wrong-password");
      await wrong.close();

      const resolved = await resolveRepoPassword({ oriId: prefix, serverSecret: SERVER_SECRET, repo, s3: S3, bin: BIN });
      expect(resolved).toBe(legacy);

      // The resolved password must actually work end to end.
      const reader = new Restic({ bin: BIN, repo, password: resolved, s3: S3 });
      await expect(reader.snapshots()).resolves.toEqual([]);
      await reader.close();
    },
    30_000,
  );

  test(
    "a repo created with the keyed password resolves to the keyed derivation",
    async () => {
      const keyedPrefix = `${prefix}-keyed`;
      const keyedRepo = oriRepoUrl(S3.endpoint, S3.bucket, keyedPrefix);
      const keyedPw = snapshotRepoPassword(keyedPrefix, SERVER_SECRET);
      const keyedRestic = new Restic({ bin: BIN, repo: keyedRepo, password: keyedPw, s3: S3 });
      await keyedRestic.init();
      await keyedRestic.close();

      const resolved = await resolveRepoPassword({
        oriId: keyedPrefix,
        serverSecret: SERVER_SECRET,
        repo: keyedRepo,
        s3: S3,
        bin: BIN,
      });
      expect(resolved).toBe(keyedPw);
    },
    30_000,
  );

  test(
    "a not-yet-existing repo resolves to the current (keyed) derivation",
    async () => {
      const fresh = `${prefix}-fresh`;
      const resolved = await resolveRepoPassword({
        oriId: fresh,
        serverSecret: SERVER_SECRET,
        repo: oriRepoUrl(S3.endpoint, S3.bucket, fresh),
        s3: S3,
        bin: BIN,
      });
      expect(resolved).toBe(snapshotRepoPassword(fresh, SERVER_SECRET));
    },
    30_000,
  );
});

function createHmacSha256(secret: string, data: string): string {
  // Re-implement the HMAC to prove the function, not to share its implementation.
  // node:crypto createHmac is the canonical primitive; this wrapper keeps the test
  // from coupling to restic.ts's import of it (which would make the assertion vacuous).
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  return createHmac("sha256", secret).update(data).digest("hex");
}
