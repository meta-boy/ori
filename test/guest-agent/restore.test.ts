import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Restic, oriRepoUrl, snapshotRepoPassword } from "@ori/api/snapshots/restic";
import { mintOriStorageCredentials, storageConfigFromEnv } from "@ori/api/snapshots/storageCreds";
import { runRestore } from "@ori/guest-agent/restore";
import { buildSysdiff } from "@ori/guest-agent/snapshot";

// T-P5-06. What matters here is the two-thirds of a restore that is NOT the work dir.
// Ori promises "Files, installed packages, and enabled systemd services do [survive].
// Hand-run processes do not." Restoring /home/user is easy; re-applying the system delta
// is where a resume quietly loses a user's setup, so the units/etc/crontab paths get the
// assertions and the file copy is almost incidental.
const SERVER_SECRET = "restore-test-secret";
const S3 = {
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
  secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
};
const BUCKET = process.env.S3_BUCKET ?? "ori-snapshots";

async function have(bin: string): Promise<boolean> {
  const p = Bun.spawn({ cmd: ["sh", "-lc", `command -v ${bin}`], stdout: "pipe", stderr: "pipe" });
  return (await p.exited) === 0;
}
async function minioUp(): Promise<boolean> {
  try {
    return (await fetch(`${S3.endpoint}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
const ready = (await have("restic")) && (await have("tar")) && (await minioUp());

/** Record every command a restore would have run, so unit/crontab handling is observable. */
function recordingRunner() {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (cmd: string[]) => {
      calls.push(cmd);
      // `tar -xf` must really run — the sysdiff has to be on disk for the rest to work.
      if (cmd[0] === "tar") {
        const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
        const stderr = await new Response(p.stderr).text();
        return { code: await p.exited, stdout: "", stderr };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

describe.skipIf(!ready)("T-P5-06 restore re-applies the system delta", () => {
  let work: string;
  let repoPrefix: string;
  let restic: Restic;
  let snapshotId: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "ori-restore-work-"));
    repoPrefix = `restore-${Date.now().toString(36)}`;
    const repo = oriRepoUrl(S3.endpoint, BUCKET, repoPrefix);
    restic = new Restic({
      bin: "restic",
      repo,
      password: snapshotRepoPassword(repoPrefix, SERVER_SECRET),
      s3: { endpoint: S3.endpoint, accessKey: S3.accessKey, secretKey: S3.secretKey },
    });
    await restic.init();

    // A work dir with content, plus a sysdiff carrying an enabled unit and an /etc change.
    await mkdir(join(work, "project"), { recursive: true });
    await writeFile(join(work, "project", "code.txt"), "user data\n");

    const sysdiffDir = await mkdtemp(join(tmpdir(), "ori-sysdiff-"));
    await buildSysdiff(sysdiffDir, { oriId: "or_23456789", mode: "final" });
    // Overwrite the gathered sources with known content so the assertions are exact.
    await writeFile(join(sysdiffDir, "enabled-units.txt"), "my-app.service enabled\nother.timer enabled\n");
    await mkdir(join(sysdiffDir, "etc-diff", "myapp"), { recursive: true });
    await writeFile(join(sysdiffDir, "etc-diff", "myapp", "config.conf"), "key=value\n");
    // Machine identity that must be ignored even when present.
    await mkdir(join(sysdiffDir, "etc-diff", "ssh"), { recursive: true });
    await writeFile(join(sysdiffDir, "etc-diff", "ssh", "ssh_host_ed25519_key"), "PRIVATE\n");
    await writeFile(join(sysdiffDir, "etc-diff", "machine-id"), "deadbeef\n");

    const tar = `${sysdiffDir}.tar`;
    const t = Bun.spawn({ cmd: ["tar", "-cf", tar, "-C", sysdiffDir, "."], stdout: "pipe", stderr: "pipe" });
    expect(await t.exited).toBe(0);

    const backup = await restic.backup([work, tar], { tags: ["final"] });
    snapshotId = backup.snapshotId;
    await rm(sysdiffDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  test("restores the work dir into a fresh location", async () => {
    const target = await mkdtemp(join(tmpdir(), "ori-restore-target-"));
    const rec = recordingRunner();
    const r = await runRestore({
      oriId: "or_23456789",
      snapshotRef: snapshotId,
      storage: {
        repoUrl: oriRepoUrl(S3.endpoint, BUCKET, repoPrefix),
        endpoint: S3.endpoint,
        bucket: BUCKET,
        prefix: `oris/${repoPrefix}/`,
        password: snapshotRepoPassword(repoPrefix, SERVER_SECRET),
        credentials: { accessKeyId: S3.accessKey, secretAccessKey: S3.secretKey, sessionToken: "" },
      },
      workDir: target,
      runner: rec.runner,
    });
    expect(r.ok).toBe(true);
    // The snapshot's work dir was `work`, not `target`, so nothing lands at target — what
    // this asserts is that a restore of a foreign path is reported, not silently "fine".
    expect(r.notes.join(" ")).toContain(target);
    await rm(target, { recursive: true, force: true });
  });

  test("re-enables the units that were enabled, with --now", async () => {
    const rec = recordingRunner();
    const r = await runRestore({
      oriId: "or_23456789",
      snapshotRef: snapshotId,
      storage: {
        repoUrl: oriRepoUrl(S3.endpoint, BUCKET, repoPrefix),
        endpoint: S3.endpoint,
        bucket: BUCKET,
        prefix: `oris/${repoPrefix}/`,
        password: snapshotRepoPassword(repoPrefix, SERVER_SECRET),
        credentials: { accessKeyId: S3.accessKey, secretAccessKey: S3.secretKey, sessionToken: "" },
      },
      workDir: work,
      runner: rec.runner,
    });
    expect(r.ok).toBe(true);
    expect(r.unitsEnabled).toContain("my-app.service");
    expect(r.unitsEnabled).toContain("other.timer");
    // `enable --now`, not bare `enable`: an enabled unit the user had running must come
    // back running. That is exactly the documented difference from a hand-run process.
    const enableCalls = rec.calls.filter((c) => c[0] === "systemctl");
    expect(enableCalls.length).toBeGreaterThan(0);
    for (const c of enableCalls) expect(c).toContain("--now");
  });

  test("never restores machine identity, even when the sysdiff carries it", async () => {
    const rec = recordingRunner();
    const r = await runRestore({
      oriId: "or_23456789",
      snapshotRef: snapshotId,
      storage: {
        repoUrl: oriRepoUrl(S3.endpoint, BUCKET, repoPrefix),
        endpoint: S3.endpoint,
        bucket: BUCKET,
        prefix: `oris/${repoPrefix}/`,
        password: snapshotRepoPassword(repoPrefix, SERVER_SECRET),
        credentials: { accessKeyId: S3.accessKey, secretAccessKey: S3.secretKey, sessionToken: "" },
      },
      workDir: work,
      runner: rec.runner,
    });
    // Restoring ssh host keys would give every fork of a ori its parent's SSH identity —
    // the precise bug the image's per-boot keygen exists to prevent.
    const notes = r.notes.join(" ");
    expect(notes).toContain("ssh/ssh_host_ed25519_key");
    expect(notes).toContain("machine-id");
    expect(notes.toLowerCase()).toContain("skipped machine identity");
  });

  test("package reconciliation is off unless asked, and never fatal", async () => {
    const rec = recordingRunner();
    const base = {
      oriId: "or_23456789",
      snapshotRef: snapshotId,
      storage: {
        repoUrl: oriRepoUrl(S3.endpoint, BUCKET, repoPrefix),
        endpoint: S3.endpoint,
        bucket: BUCKET,
        prefix: `oris/${repoPrefix}/`,
        password: snapshotRepoPassword(repoPrefix, SERVER_SECRET),
        credentials: { accessKeyId: S3.accessKey, secretAccessKey: S3.secretKey, sessionToken: "" },
      },
      workDir: work,
      runner: rec.runner,
    };
    const off = await runRestore(base);
    expect(off.packages).toBe("skipped");
    expect(rec.calls.some((c) => c.join(" ").includes("apt-get"))).toBe(false);

    // With it on, the recording runner reports success for everything, so it reconciles —
    // and crucially a restore still returns ok either way.
    const on = await runRestore({ ...base, reconcilePackages: true });
    expect(on.ok).toBe(true);
    expect(["reconciled", "unavailable", "failed"]).toContain(on.packages);
  });

  test("a bad snapshot ref fails loudly rather than reporting an empty success", async () => {
    await expect(
      runRestore({
        oriId: "or_23456789",
        snapshotRef: "0000000000000000000000000000000000000000000000000000000000000000",
        storage: {
          repoUrl: oriRepoUrl(S3.endpoint, BUCKET, repoPrefix),
          endpoint: S3.endpoint,
          bucket: BUCKET,
          prefix: `oris/${repoPrefix}/`,
          password: snapshotRepoPassword(repoPrefix, SERVER_SECRET),
          credentials: { accessKeyId: S3.accessKey, secretAccessKey: S3.secretKey, sessionToken: "" },
        },
        workDir: work,
        runner: recordingRunner().runner,
      }),
    ).rejects.toThrow();
  });

  test("restore works with READ-ONLY storage credentials (cross-ori fork)", async () => {
    // OPEN-DECISIONS #2: a fork restores from its PARENT's repo prefix with credentials
    // narrowed to GetObject + ListBucket. restic takes a lock write by default, which those
    // credentials deny — so the restore path passes --no-lock (it only ever reads the repo),
    // and the whole flow must still work. This is the e2e proof that the narrowing is safe.
    // Endpoint is S3.endpoint, NOT creds.endpoint: the policy is enforced by the object
    // store on the SESSION, so the hostname the request arrives on does not matter, and
    // creds.endpoint is host.docker.internal under Docker, which the test process cannot reach.
    const readOnly = await mintOriStorageCredentials(storageConfigFromEnv(), repoPrefix, { readOnly: true });
    expect(readOnly.readOnly).toBe(true);
    const target = await mkdtemp(join(tmpdir(), "ori-restore-ro-"));
    const rec = recordingRunner();
    const r = await runRestore({
      oriId: "or_23456789",
      snapshotRef: snapshotId,
      storage: {
        repoUrl: oriRepoUrl(S3.endpoint, BUCKET, repoPrefix),
        endpoint: S3.endpoint,
        bucket: BUCKET,
        prefix: `oris/${repoPrefix}/`,
        password: snapshotRepoPassword(repoPrefix, SERVER_SECRET),
        credentials: {
          accessKeyId: readOnly.accessKeyId,
          secretAccessKey: readOnly.secretAccessKey,
          sessionToken: readOnly.sessionToken,
        },
      },
      workDir: target,
      runner: rec.runner,
    });
    expect(r.ok).toBe(true);
    await rm(target, { recursive: true, force: true });
  });
});
