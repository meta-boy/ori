import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Restic, type ResticS3Credentials } from "@ori/api/snapshots/restic";
import { DEFAULT_WORK_DIR } from "./exec";

/**
 * T-P5-03 — POST /snapshot: a restic backup of the ori.
 *
 * WHAT IS CAPTURED:
 *   - the work dir (ORI_WORK_DIR, /home/user in a real ori),
 *   - /var/lib/docker/volumes (skipped silently when absent),
 *   - one sysdiff.tar that holds the SYSTEM DELTA — dpkg --get-selections, the
 *     enabled systemd units, a diff of /etc against the base-image manifest,
 *     and the crontabs — so installed packages and enabled units survive a
 *     stop/resume without backing /etc up wholesale.
 *
 * WHAT IS EXCLUDED: the base OS, preinstalled tools, machine
 * identity (hostname, ssh host keys, /etc/machine-id — the image regenerates
 * these per ori by design), running processes and open ports.
 *
 * SECURITY: the storage credentials in the request body were minted by the
 * control plane (T-P5-02), are scoped to this ori's object prefix and expire
 * within the hour. The repo password is DERIVED by the control plane
 * (T-P5-01) and passed alongside — the ori is its own repo's owner, so it may
 * hold both. But neither may ever be logged or echoed in an error, so every
 * failure path runs through redactSecrets.
 *
 * mode: 'auto' is a routine periodic backup; 'final' is the one that blocks a
 * stop, so it must be HONEST — a restic failure is surfaced as a clear failure
 * (a ori whose final snapshot failed stays up and UNBILLED,
 * which only works if the caller is told the truth).
 */

export const DEFAULT_VOLUMES_DIR = "/var/lib/docker/volumes";
export const DEFAULT_ETC_BASELINE = "/opt/ori/ori-image/etc-manifest.json";

/**
 * Where the last successful snapshot's fingerprint lives. Written only by a CONFIRMED
 * backup and read before every snapshot to decide whether anything changed.
 *
 * Durable for the life of the CONTAINER, not of the sandbox: a stop destroys the machine, so a
 * resumed ori starts with no fingerprint and cannot skip its first snapshot. That is the safe
 * direction to fail, and it is why this is not stored alongside the snapshot itself.
 */
export const DEFAULT_FINGERPRINT_PATH = "/var/lib/ori/last-snapshot";

/** restic's own per-command cap, tightened for an in-ori snapshot. */
const RESTIC_TIMEOUT_MS = 60_000;

export type SnapshotMode = "auto" | "final";

/** The `storage` object of a POST /snapshot body (control-plane minted, §5). */
export interface SnapshotStorageConfig {
  repoUrl: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  region?: string;
  /** Repo unlock password, derived by the control plane. Never logged. */
  password: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };
}

export interface SnapshotRequest {
  mode: SnapshotMode;
  storage: SnapshotStorageConfig;
}

export type SnapshotResult =
  | {
      ok: true;
      type: "snapshot.created";
      mode: SnapshotMode;
      snapshotId: string;
      /** Logical bytes captured (restic totalBytesProcessed). */
      sizeBytes: number;
      /** Files captured (restic totalFilesProcessed). */
      fileCount: number;
      createdAt: string;
    }
  | {
      ok: true;
      type: "snapshot.skipped";
      mode: SnapshotMode;
      /** Why no backup was taken — always "no changes", never an error. */
      reason: string;
      createdAt: string;
    };

/** Validate a POST /snapshot body; returns an error message when invalid. */
export function parseSnapshotRequest(
  body: unknown,
): { ok: true; value: SnapshotRequest } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) return { ok: false, message: "invalid body" };
  const { mode, storage } = body as Record<string, unknown>;
  if (mode !== "auto" && mode !== "final") return { ok: false, message: "mode must be 'auto' or 'final'" };
  if (typeof storage !== "object" || storage === null || Array.isArray(storage)) {
    return { ok: false, message: "storage is required" };
  }
  const s = storage as Record<string, unknown>;
  for (const k of ["repoUrl", "endpoint", "bucket", "prefix"]) {
    if (typeof s[k] !== "string" || s[k] === "") return { ok: false, message: `storage.${k} is required` };
  }
  if (typeof s.password !== "string" || s.password === "") {
    return { ok: false, message: "storage.password is required" };
  }
  if (s.region !== undefined && (typeof s.region !== "string" || s.region === "")) {
    return { ok: false, message: "storage.region must be a non-empty string" };
  }
  const creds = s.credentials;
  if (typeof creds !== "object" || creds === null || Array.isArray(creds)) {
    return { ok: false, message: "storage.credentials is required" };
  }
  const c = creds as Record<string, unknown>;
  for (const k of ["accessKeyId", "secretAccessKey"]) {
    if (typeof c[k] !== "string" || c[k] === "") {
      return { ok: false, message: `storage.credentials.${k} is required` };
    }
  }
  if (c.sessionToken !== undefined && typeof c.sessionToken !== "string") {
    return { ok: false, message: "storage.credentials.sessionToken must be a string" };
  }
  return {
    ok: true,
    value: {
      mode,
      storage: {
        repoUrl: s.repoUrl as string,
        endpoint: s.endpoint as string,
        bucket: s.bucket as string,
        prefix: s.prefix as string,
        region: s.region as string | undefined,
        password: s.password as string,
        credentials: {
          accessKeyId: c.accessKeyId as string,
          secretAccessKey: c.secretAccessKey as string,
          sessionToken: (c.sessionToken as string | undefined) ?? "",
        },
      },
    },
  };
}

/**
 * Replace every occurrence of the repo password and the S3 credential strings
 * in `text` before it is logged or returned. The credential strings are short
 * and could in principle surface in a vendor error; this guarantees the rule
 * "never log the repo password or the S3 secret" even then.
 */
export function redactSecrets(storage: SnapshotStorageConfig, text: string): string {
  const secrets = [
    storage.password,
    storage.credentials.accessKeyId,
    storage.credentials.secretAccessKey,
    storage.credentials.sessionToken,
  ].filter((s): s is string => Boolean(s));
  let out = text;
  for (const s of secrets) out = out.split(s).join("<redacted>");
  return out;
}

export interface RunSnapshotInput {
  oriId: string;
  mode: SnapshotMode;
  storage: SnapshotStorageConfig;
  workDir?: string;
  volumesDir?: string;
  etcBaselinePath?: string;
  resticBin?: string;
  tmpDir?: string;
  resticTimeoutMs?: number;
  /**
   * Where the change-detection fingerprint is persisted. Defaults to
   * /var/lib/ori/last-snapshot; tests point it at a temp file. A path that
   * cannot be written degrades to "never skip", which is always safe.
   */
  fingerprintPath?: string;
  /** /etc root the fingerprint probe stats. Defaults to /etc; tests use a temp dir. */
  etcRoot?: string;
  /** dpkg status file the probe stats. Defaults to /var/lib/dpkg/status. */
  dpkgStatusFile?: string;
  /** Per-user crontab spool the probe stats. Defaults to /var/spool/cron/crontabs. */
  crontabSpoolDir?: string;
}

/**
 * Build the sysdiff and take a restic backup of [workDir, volumes?, sysdiff.tar].
 * Returns a snapshot result or a SKIPPED result when nothing changed since the
 * last successful snapshot; throws on any failure (never a false success).
 *
 * The change check runs FIRST, before the sysdiff build: the sysdiff is the
 * expensive part (dpkg --get-selections, systemctl, and a full /etc walk that
 * sha256-hashes every file), and for an idle ori it reproduces almost all of the
 * previous one. The probe is a full traversal too — one lstat per entry across
 * the workdir, volumes and /etc — but it never opens a file, so an unchanged ori
 * costs a directory walk instead of ~0.5-2s of hashing and tarring CPU.
 *
 * Skips apply to `auto` only; see the gate below for why `final` never skips.
 */
export async function runSnapshot(input: RunSnapshotInput): Promise<SnapshotResult> {
  const workDir = input.workDir ?? process.env.ORI_WORK_DIR ?? DEFAULT_WORK_DIR;
  const volumesDir = input.volumesDir ?? DEFAULT_VOLUMES_DIR;
  const base = input.tmpDir ?? tmpdir();
  const ori = input.oriId;

  const fingerprintPath = input.fingerprintPath ?? DEFAULT_FINGERPRINT_PATH;
  const probe = await computeSnapshotFingerprint({
    workDir,
    volumesDir,
    etcRoot: input.etcRoot,
    dpkgStatusFile: input.dpkgStatusFile,
    crontabSpoolDir: input.crontabSpoolDir,
  });
  const last = await readLastFingerprint(fingerprintPath);
  /*
   * `auto` only. A skip is a cadence optimisation, and the one thing it must never optimise away
   * is the last snapshot a disk will ever get.
   *
   * The probe is a heuristic with a stated ceiling (see TreeProbe: an edit that preserves both
   * size and mtime is invisible to it), and a missed `auto` is cheap — the disk is still there and
   * the next change moves the fingerprint. A missed `final` is not recoverable: `stopOri` destroys
   * the container the moment the snapshot reports success, so anything the probe failed to notice
   * is gone. The stop path pays the full cost every time and stays honest, which is what the
   * `final` mode exists for.
   */
  if (input.mode === "auto" && last !== null && last === probe) {
    return {
      ok: true,
      type: "snapshot.skipped",
      mode: input.mode,
      reason: "no changes since the last successful snapshot",
      createdAt: new Date().toISOString(),
    };
  }

  const contentDir = join(base, `ori-sysdiff-${ori}`);
  const sysdiffTar = `${contentDir}.tar`;
  await rm(contentDir, { recursive: true, force: true });
  await rm(sysdiffTar, { force: true });
  await buildSysdiff(contentDir, { oriId: ori, mode: input.mode, etcBaselinePath: input.etcBaselinePath });
  await createTar(sysdiffTar, contentDir);

  const paths = [workDir];
  if (existsSync(volumesDir)) paths.push(volumesDir);
  paths.push(sysdiffTar);

  const s3: ResticS3Credentials = {
    endpoint: input.storage.endpoint,
    accessKey: input.storage.credentials.accessKeyId,
    secretKey: input.storage.credentials.secretAccessKey,
    region: input.storage.region,
  };
  if (input.storage.credentials.sessionToken) s3.sessionToken = input.storage.credentials.sessionToken;

  const restic = new Restic({
    bin: input.resticBin ?? process.env.RESTIC_BIN ?? "restic",
    repo: input.storage.repoUrl,
    password: input.storage.password,
    timeoutMs: input.resticTimeoutMs ?? RESTIC_TIMEOUT_MS,
    s3,
  });

  try {
    await restic.init();
    const { snapshotId, summary } = await restic.backup(paths, { tags: [`ori=${ori}`, `mode=${input.mode}`] });
    // Persist the fingerprint ONLY after a confirmed success: a failed backup
    // must not look "unchanged" on the next tick, or the change would be lost.
    await writeLastFingerprint(fingerprintPath, probe).catch(() => {
      // Best-effort by design. An unwritable fingerprint path (a dev host
      // without /var/lib/ori, or a readonly mount) degrades to "never skip",
      // which costs a snapshot but never loses data.
    });
    return {
      ok: true,
      type: "snapshot.created",
      mode: input.mode,
      snapshotId,
      sizeBytes: summary.totalBytesProcessed,
      fileCount: summary.totalFilesProcessed,
      createdAt: new Date().toISOString(),
    };
  } finally {
    await restic.close();
  }
}

/* ------------------------ change detection probe ----------------------- */

/**
 * Change detection. Before the expensive sysdiff build, run a CHEAP probe and
 * compare it to the fingerprint left by the last SUCCESSFUL backup. Equal ⇒ nothing
 * the snapshot captures has changed, so the copy already in the repo still describes
 * this disk and there is nothing to add. (Not "byte-identical": the sysdiff manifest
 * embeds its own createdAt, so a rebuilt tar always differs in that field. What is
 * unchanged is the data, which is what restic would dedupe away anyway.)
 *
 * The probe must never hash file contents — hashing is exactly what made the old
 * per-tick work expensive — so it is entry counts, sizes and mtimes from a
 * readdir/lstat walk, nothing more.
 *
 * The probed sources mirror what the sysdiff captures, so anything that would
 * change a snapshot changes the fingerprint:
 *   - work dir and volumes: max file/symlink mtime across the tree (content
 *     edits bump mtimes),
 *   - /var/lib/dpkg/status: one stat — dpkg advances it on every package change,
 *     which is what dpkg-selections.txt would reflect,
 *   - /etc: max mtime, with machine-identity paths excluded exactly as diffEtc
 *     excludes them, so a regenerated hostname/machine-id is not a snapshot.
 *
 * KNOWN CEILING: the probe cannot see a change that leaves every probed mtime
 * alone — a file rewritten with the same mtime, for example. That is the price
 * of "no content hashing"; the sysdiff (when a snapshot does run) remains the
 * authority, and a missed change is bounded by the cadence of real changes.
 */
export interface SnapshotFingerprintInput {
  workDir: string;
  volumesDir: string;
  /** /etc root to walk. Defaults to /etc; tests point it at a temp dir. */
  etcRoot?: string;
  /** dpkg status file to stat. Defaults to /var/lib/dpkg/status. */
  dpkgStatusFile?: string;
  /** Per-user crontab spool to walk. Defaults to /var/spool/cron/crontabs. */
  crontabSpoolDir?: string;
}

/** Latest mtime (ms) of a single path; 0 when absent. */
async function mtimeMs(p: string): Promise<number> {
  try {
    return Math.floor((await lstat(p)).mtimeMs);
  } catch {
    return 0;
  }
}

/**
 * Max mtime (ms) across a tree, without following symlinked dirs (no cycles),
 * 0 when the tree is absent. `isExcluded` receives each path RELATIVE to the
 * root; only the /etc probe passes one (machine identity).
 *
 * Only files and symlinks are statted — not directories. A directory's mtime
 * bumps on any entry add/remove, which on a real ori includes the first-boot
 * creation of the very machine-identity files the /etc probe excludes; counting
 * dir mtimes would therefore turn identity regeneration into a false "change".
 * KNOWN CEILING: a change that consists solely of a new empty directory (no
 * file inside it) is missed until some real file changes — the accepted price of
 * keeping the probe free of dir-mtime noise.
 */
/**
 * What one tree contributes to the fingerprint: how many entries it holds, how many bytes they
 * total, and the newest mtime among them.
 *
 * Max mtime ALONE is not safe, which is the whole reason this is three numbers instead of one.
 * `tar -x`, `unzip`, `cp -p` and `rsync --times` all restore the archive's own mtimes, which are
 * normally older than the newest file already in the tree — so extracting a tarball, the most
 * ordinary thing a person does in a sandbox, would leave the maximum untouched and the snapshot
 * would be skipped with the new work never backed up. Deleting anything other than the newest
 * file has the same shape. Counting entries and summing their sizes catches creation, deletion
 * and any size-changing edit no matter what the clock did, and costs one lstat per entry, which
 * the walk already pays.
 *
 * Directories are recursed into but never counted or stat'd themselves. That is deliberate: the
 * /etc exclusions are file prefixes (`/etc/ssh/ssh_host_`), so the `/etc/ssh` directory holding
 * per-ori identity keys is NOT excluded, and counting it would make the probe move every boot for
 * exactly the identity churn the exclusion list exists to ignore. Counting only leaf entries loses
 * nothing that matters: an empty directory appearing or vanishing carries no user data, and any
 * file inside one moves the count on its own.
 *
 * ponytail: an edit that preserves size AND mtime still slips through — it takes deliberate
 * effort (rewriting to the same length, then restoring the timestamp) and the fix is content
 * hashing, which is what this probe exists to avoid. Hash if that ever shows up in practice.
 */
interface TreeProbe {
  entries: number;
  bytes: number;
  maxMtimeMs: number;
}

async function probeTree(root: string, isExcluded: (rel: string) => boolean = () => false): Promise<TreeProbe> {
  const probe: TreeProbe = { entries: 0, bytes: 0, maxMtimeMs: 0 };
  if (!existsSync(root)) return probe;
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable subtree contributes nothing rather than failing the probe
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (isExcluded(relPath)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, relPath);
        continue;
      }
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue; // an entry that vanished mid-walk is not a change to snapshot
      }
      probe.entries++;
      probe.bytes += st.size;
      if (st.mtimeMs > probe.maxMtimeMs) probe.maxMtimeMs = st.mtimeMs;
    }
  };
  await walk(root, "");
  probe.maxMtimeMs = Math.floor(probe.maxMtimeMs);
  return probe;
}

/** Render one tree's probe into the fingerprint payload. */
function renderProbe(p: TreeProbe): string {
  return `${p.entries}/${p.bytes}/${p.maxMtimeMs}`;
}

/**
 * Compute the current fingerprint as a single comparable string. `v1:` prefixes
 * the payload so a format change can never silently match an old stored value.
 */
export async function computeSnapshotFingerprint(input: SnapshotFingerprintInput): Promise<string> {
  const etcRoot = input.etcRoot ?? "/etc";
  const dpkgStatus = input.dpkgStatusFile ?? "/var/lib/dpkg/status";
  const crontabSpool = input.crontabSpoolDir ?? "/var/spool/cron/crontabs";
  // The etc walk rebuilds the canonical /etc path so the same ETCD_EXCLUDED
  // prefixes used by diffEtc apply verbatim.
  const etcExcluded = (rel: string): boolean => isExcludedEtc(`/etc/${rel}`);
  const [work, volumes, etc, spool] = await Promise.all([
    probeTree(input.workDir),
    probeTree(input.volumesDir),
    probeTree(etcRoot, etcExcluded),
    probeTree(crontabSpool),
  ]);
  const dpkg = await mtimeMs(dpkgStatus);
  // v2: entry count and byte total joined the payload. The version prefix is what stops a
  // v1 fingerprint on disk from ever comparing equal to a v2 probe and skipping a snapshot
  // it has no basis to skip.
  return `v2:${renderProbe(work)}:${renderProbe(volumes)}:${dpkg}:${renderProbe(etc)}:${renderProbe(spool)}`;
}

/** The last persisted fingerprint, or null when none exists (first snapshot). */
export async function readLastFingerprint(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    // No fingerprint yet — the caller must snapshot; this is the baseline, not a skip.
    return null;
  }
}

/** Persist the fingerprint of a CONFIRMED backup, atomically (tmp + rename). */
export async function writeLastFingerprint(path: string, fingerprint: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // tmp + rename so a crash mid-write cannot leave a truncated file that happens
  // to match a future probe.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, fingerprint);
  await rename(tmp, path);
}

/* --------------------------- the sysdiff ---------------------------- */

export interface SysdiffInput {
  oriId: string;
  mode: SnapshotMode;
  etcBaselinePath?: string;
  now?: () => Date;
}

/**
 * Gather the system delta into `contentDir` as plain files; the
 * caller tars the directory. Each source degrades gracefully — a dev host or
 * a minimal ori without dpkg/systemctl still produces a well-formed sysdiff,
 * so a snapshot never fails because a diagnostic source is missing.
 */
export async function buildSysdiff(contentDir: string, input: SysdiffInput): Promise<void> {
  await mkdir(contentDir, { recursive: true });
  const now = input.now ?? (() => new Date());

  const dpkg = await runTool(["dpkg", "--get-selections"]);
  await writeFile(
    join(contentDir, "dpkg-selections.txt"),
    dpkg.code === 0 ? dpkg.stdout : "# dpkg --get-selections unavailable here (not an Ubuntu ori?)\n",
  );

  const units = await runTool(["systemctl", "list-unit-files", "--state=enabled", "--no-legend", "--no-pager"]);
  await writeFile(
    join(contentDir, "enabled-units.txt"),
    units.code === 0 ? units.stdout : "# systemctl unavailable here (not a systemd ori?)\n",
  );

  await writeFile(join(contentDir, "crontabs.txt"), await gatherCrontabs());

  const baselinePath = input.etcBaselinePath ?? DEFAULT_ETC_BASELINE;
  const diff = await diffEtc("/etc", baselinePath, join(contentDir, "etc-diff"));
  await writeFile(join(contentDir, "etc-diff.json"), `${JSON.stringify(diff, null, 2)}\n`);

  await writeFile(
    join(contentDir, "manifest.txt"),
    [
      "# ori snapshot sysdiff",
      `oriId: ${input.oriId}`,
      `mode: ${input.mode}`,
      `createdAt: ${now().toISOString()}`,
      "sources: dpkg-selections.txt, enabled-units.txt, etc-diff/ + etc-diff.json (vs the base-image manifest), crontabs.txt",
      "excluded by design: the base OS, preinstalled tools, machine identity, running processes, open ports",
    ].join("\n") + "\n",
  );
}

/** Subtrees under /etc that hold config a user installs. Used when there is no baseline. */
const ETC_FALLBACK_SUBTREES = ["systemd/system", "systemd/user", "cron.d", "cron.daily", "crontab"];

async function captureEtcSubtrees(liveRoot: string, outDir: string): Promise<EtcDiffResult> {
  const added: string[] = [];
  const skipped: string[] = [];
  for (const sub of ETC_FALLBACK_SUBTREES) {
    const src = join(liveRoot, sub);
    if (!existsSync(src)) continue;
    const dest = join(outDir, sub);
    const st = await stat(src).catch(() => null);
    if (!st) continue;
    try {
      if (st.isDirectory()) {
        await mkdir(dest, { recursive: true });
        await cp(src, dest, { recursive: true, force: true, dereference: false });
      } else {
        await mkdir(dirname(dest), { recursive: true });
        await cp(src, dest, { force: true });
      }
      added.push(`/etc/${sub}`);
    } catch {
      skipped.push(`/etc/${sub}`);
    }
  }
  return { noBaseline: true, fallbackSubtrees: true, changed: [], added, removed: [], symlinks: {}, skipped };
}

interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a tool; a missing binary is a -1 code, never a throw. */
async function runTool(cmd: string[], timeoutMs = 30_000): Promise<ToolResult> {
  let proc;
  try {
    proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  } catch {
    return { code: -1, stdout: "", stderr: "" };
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** Tar a content dir into a single archive at tarPath (system tar). */
async function createTar(tarPath: string, contentDir: string): Promise<void> {
  const r = await runTool(["tar", "-cf", tarPath, "-C", contentDir, "."], 60_000);
  if (r.code !== 0) {
    throw new Error(`sysdiff tar failed (exit ${r.code}): ${r.stderr || r.stdout}`);
  }
}

/** Collect /etc/crontab, /etc/cron.d/* and per-user crontabs into one text file. */
async function gatherCrontabs(): Promise<string> {
  const parts = ["# ori snapshot crontabs"];
  const append = async (p: string): Promise<void> => {
    try {
      parts.push(`--- ${p} ---`);
      parts.push(await readFile(p, "utf8"));
    } catch {
      // missing/unreadable: skip
    }
  };
  await append("/etc/crontab");
  for (const dir of ["/etc/cron.d"]) {
    try {
      for (const e of (await readdir(dir)).sort()) await append(join(dir, e));
    } catch {
      // no such dir
    }
  }
  try {
    for (const e of (await readdir("/var/spool/cron/crontabs")).sort()) {
      await append(join("/var/spool/cron/crontabs", e));
    }
  } catch {
    // no per-user crontab spool
  }
  if (parts.length === 1) parts.push("# no crontabs found");
  return parts.join("\n") + "\n";
}

/* --------------------------- the /etc diff -------------------------- */

/**
 * Machine identity. The image ships NO ssh host keys and an empty
 * /etc/machine-id (image/provision.sh cleanup); each ori regenerates these at
 * first boot. Backing them up would let every fork impersonate its parent, so
 * the /etc diff excludes them by path prefix.
 */
export const ETCD_EXCLUDED = [
  "/etc/hostname",
  "/etc/hosts",
  "/etc/machine-id",
  "/etc/ssh/ssh_host_",
  "/etc/resolv.conf",
];

export interface EtcDiffResult {
  /** True when no baseline existed and the curated /etc subtrees were copied instead. */
  fallbackSubtrees?: boolean;
  /** No baseline manifest in the image — nothing to diff against. */
  noBaseline?: boolean;
  /** The live /etc itself is missing (test/dev host). */
  liveMissing?: boolean;
  /** Regular files whose content changed; stored under etc-diff/<rel>. */
  changed: string[];
  /** Regular files new since the baseline; stored under etc-diff/<rel>. */
  added: string[];
  /** Baseline paths no longer present; the restore side must delete them. */
  removed: string[];
  /** Symlinks that were added or changed; key = path, value = new target. */
  symlinks: Record<string, string>;
  /** Machine-identity paths seen live and deliberately NOT captured. */
  skipped: string[];
}

function isExcludedEtc(p: string): boolean {
  return ETCD_EXCLUDED.some((x) => p === x || p.startsWith(x));
}

async function sha256File(p: string): Promise<string> {
  return createHash("sha256").update(await readFile(p)).digest("hex");
}

/** Walk a dir tree without following symlinked dirs (no cycles). */
async function walkEtc(root: string, visit: (abs: string, isSymlink: boolean) => Promise<void>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const abs = join(root, e.name);
    if (e.isSymbolicLink()) {
      await visit(abs, true);
    } else if (e.isDirectory()) {
      await walkEtc(abs, visit);
    } else if (e.isFile()) {
      await visit(abs, false);
    }
  }
}

/**
 * Diff the live /etc against the base-image manifest and write the content of
 * every changed/added regular file under `outDir/<rel>`. Returns the lists the
 * restore side (T-P5-06) needs, including which identity paths were skipped.
 *
 * The manifest, the exclusion list and the returned paths all speak the
 * CANONICAL /etc namespace (`/etc/...`), while `liveRoot` is the filesystem
 * location that holds them — normally `/etc`, but a temp dir in tests. This
 * keeps the function hermetically testable without a real /etc.
 */
export async function diffEtc(liveRoot: string, baselinePath: string, outDir: string): Promise<EtcDiffResult> {
  await mkdir(outDir, { recursive: true });
  if (!existsSync(baselinePath)) {
    // No baseline manifest (the image does not ship one yet). Capturing NOTHING here is
    // silent data loss: "enabled systemd services survive a stop/resume" is documented
    // behaviour, and without the /etc delta a resumed ori has no unit files at all — which
    // is exactly what happened, with no error anywhere. Fall back to copying the subtrees
    // where user-installed config actually lives. Broader than a true diff (it takes some
    // base-image files too), but a resume that restores too much beats one that loses the
    // user's services.
    return await captureEtcSubtrees(liveRoot, outDir);
  }
  if (!existsSync(liveRoot)) {
    return { liveMissing: true, changed: [], added: [], removed: [], symlinks: {}, skipped: [] };
  }

  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
    version?: number;
    files?: Record<string, { sha256: string }>;
    symlinks?: Record<string, string>;
    dirs?: string[];
  };
  const baselineFiles = baseline.files ?? {};
  const baselineSymlinks = baseline.symlinks ?? {};

  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const symlinks: Record<string, string> = {};
  const skipped: string[] = [];
  const seen = new Set<string>();

  const rel = (p: string): string => p.slice(liveRoot.length).replace(/^[/\\]+/, "");
  const key = (p: string): string => `/etc/${rel(p)}`;

  await walkEtc(liveRoot, async (p, isSymlink) => {
    const k = key(p);
    if (isExcludedEtc(k)) {
      skipped.push(k);
      return;
    }
    seen.add(k);
    if (isSymlink) {
      const target = await readlink(p);
      if (baselineSymlinks[k] !== target) {
        changed.push(k);
        symlinks[k] = target;
      }
      return;
    }
    const baselineFile = baselineFiles[k];
    if (baselineFile) {
      if (baselineFile.sha256 !== (await sha256File(p))) {
        changed.push(k);
        await storeDiffedContent(outDir, rel(p), p);
      }
    } else {
      added.push(k);
      await storeDiffedContent(outDir, rel(p), p);
    }
  });

  for (const p of Object.keys(baselineFiles)) {
    if (!seen.has(p) && !isExcludedEtc(p)) removed.push(p);
  }
  for (const p of Object.keys(baselineSymlinks)) {
    if (!seen.has(p) && !isExcludedEtc(p)) removed.push(p);
  }

  return { changed, added, removed, symlinks, skipped };
}

async function storeDiffedContent(outDir: string, rel: string, source: string): Promise<void> {
  const target = join(outDir, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(source));
}
