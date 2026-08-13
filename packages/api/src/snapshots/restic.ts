import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Thin wrapper over the restic binary (T-P5-01). ori snapshots are file-level,
 * content-addressed, deduped, incremental, with a file tree, single-file
 * extraction and folder-as-tar extraction — restic gives
 * all of that, so we write zero snapshot code of our own.
 *
 * VERSION SKEW — the binary here and the binary inside a ori are NOT the same.
 * The ori image ships the distro's restic 0.16.4; a dev machine typically has a
 * newer brew build (0.19.x). Snapshots are written and read inside the ori by
 * the ori's own copy; the host binary is used by the control plane for the
 * read-side (snapshots, ls, dump) and by the tests. The repo format is stable
 * across both, but never assume identical CLI output between the two.
 *
 * Every call takes the binary path, repo URL, password and S3 credentials as
 * explicit inputs — never read process.env deep inside. The guest agent will
 * run with per-ori scoped credentials (T-P5-02), which a function that reaches
 * for globals could not be given.
 *
 * The password and the S3 secret travel only in the child process environment,
 * never on the command line and never in a thrown error. A failure always
 * carries restic's stderr: a swallowed restic error is unfixable in production.
 */

/** S3-style credentials restic's s3 backend talks to. */
export interface ResticS3Credentials {
  /** e.g. `http://localhost:9000`. Scheme included; trailing slash optional. */
  endpoint: string;
  accessKey: string;
  secretKey: string;
  /** MinIO ignores it; AWS needs a real region. Defaults to us-east-1. */
  region?: string;
  /**
   * Session token from an STS AssumeRole (T-P5-02). restic reads it from
   * AWS_SESSION_TOKEN; a scoped temporary credential without its token is
   * useless, so a missing sessionToken on a ori's credential would fail the
   * backup with an opaque auth error — this field exists so the token is
   * passed through rather than dropped.
   */
  sessionToken?: string;
}

export interface ResticConfig {
  /** Path to the restic binary. Defaults to `restic` on PATH. */
  bin?: string;
  /** Repo URL, e.g. `s3:http://localhost:9000/ori-snapshots/oris/<oriId>`. */
  repo: string;
  /** Repo unlock password. NEVER logged, never on the command line. */
  password: string;
  s3: ResticS3Credentials;
  /**
   * restic's local cache dir. Defaults to a PERSISTENT per-repo directory under
   * /var/cache/ori-restic (keyed by a hash of the repo URL); where that is not
   * writable it falls back to a per-instance temp dir that close() deletes. Pass
   * an explicit dir to override either default.
   */
  cacheDir?: string;
  /** Wall-clock cap per command. Default 120s. */
  timeoutMs?: number;
}

/** A `restic snapshots --json` entry. */
export interface ResticSnapshot {
  id: string;
  shortId: string;
  time: string;
  paths: string[];
  hostname: string;
  username: string;
  tags: string[];
  parent: string | null;
  tree: string;
}

/** A node from `restic ls --json`, already mapped to the {path, kind, size} shape. */
export interface ResticNode {
  path: string;
  name: string;
  kind: "file" | "dir" | "symlink";
  /** Byte size; 0 for directories and symlinks (restic reports null). */
  size: number;
  mode?: number;
}

export interface ResticBackupSummary {
  filesNew: number;
  filesChanged: number;
  filesUnmodified: number;
  dirsNew: number;
  dirsChanged: number;
  dataAdded: number;
  dataAddedPacked: number;
  totalBytesProcessed: number;
  totalFilesProcessed: number;
}

export interface ResticBackupResult {
  snapshotId: string;
  summary: ResticBackupSummary;
}

export interface ResticForgetResult {
  keepIds: string[];
  removeIds: string[];
  /** Full 64-hex ids of the removed snapshots — the control plane keys rows on these. */
  removeFullIds: string[];
  groups: number;
}

/** Retention policy for `forget`. Empty = keep everything. */
export interface ResticForgetOptions {
  /** Keep the newest N snapshots in each group. */
  keepLast?: number;
  /** Keep the newest snapshot per day, for the last N days. */
  keepDaily?: number;
}

/** A `restic dump` in flight: the bytes/tar stream plus a wait() that surfaces errors. */
export interface ResticDump {
  /** A single file's bytes, or a folder serialized as tar. */
  body: ReadableStream<Uint8Array>;
  /** Resolves once the process exits; throws ResticError on failure/timeout. */
  wait: () => Promise<void>;
}

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RawBackupLine {
  message_type?: string;
  snapshot_id?: unknown;
  files_new?: unknown;
  files_changed?: unknown;
  files_unmodified?: unknown;
  dirs_new?: unknown;
  dirs_changed?: unknown;
  data_added?: unknown;
  data_added_packed?: unknown;
  total_bytes_processed?: unknown;
  total_files_processed?: unknown;
}

interface RawSnapshot {
  id: string;
  short_id: string;
  time: string;
  tree: string;
  paths?: string[];
  hostname: string;
  username: string;
  tags?: string[] | null;
  parent?: string | null;
}

interface RawLsLine {
  message_type?: string;
  name?: unknown;
  type?: unknown;
  path?: unknown;
  size?: unknown;
  mode?: unknown;
}

interface RawForgetSnapshot {
  id: string;
  short_id: string;
}

interface RawForgetGroup {
  keep: RawForgetSnapshot[] | null;
  remove: RawForgetSnapshot[] | null;
}

/**
 * One repository per ori, at `s3:<endpoint>/<bucket>/oris/<oriId>`. The
 * endpoint already carries its scheme (`http://localhost:9000`).
 */
export function oriRepoUrl(endpoint: string, bucket: string, oriId: string): string {
  return `s3:${endpoint.replace(/\/+$/, "")}/${bucket}/oris/${oriId}`;
}

/**
 * Repo password for a ori, DERIVED — not stored — so it survives any row
 * deletion. DESIGN DECISION (T-P5-01, see the commit message): the password is
 * `HMAC-SHA256(serverSecret, "ori-snapshot-repo:" + keyId + ":" + oriId)`, hex-encoded.
 *
 * KEY ID (OPEN-DECISIONS #1, RESOLVED): the derivation carries a version prefix
 * (`v1` today, via env `KEY_ID`, never a default in code — a deployment rotating
 * the snapshot secret sets KEY_ID=v2 and the OLD repos keep resolving to the v1
 * password via snapshotRepoPasswords()). Without the prefix the secret could
 * never be rotated: changing it would orphan every repo at once.
 *
 * Why derived and not a column: a fork restores from the SOURCE ori's repo, and
 * a fork of a ori you no longer have must still work. A password stored in a
 * oris column dies with the source's row; a derived one needs only the source
 * ori id, which resume (own id) and fork (source id, carried in the request)
 * always have. The server secret is out-of-band config (env ORI_SNAPSHOT_SECRET)
 * and is the single thing that makes every repo reopenable — keep it stable,
 * and never log it.
 */
export function snapshotRepoPassword(
  oriId: string,
  serverSecret: string,
  keyId: string = process.env.KEY_ID ?? "v1",
): string {
  return createHmac("sha256", serverSecret).update(`ori-snapshot-repo:${keyId}:${oriId}`).digest("hex");
}

/**
 * The derivation used before key ids existed (`HMAC(secret, "ori-snapshot-repo:" +
 * oriId)`, no version prefix). Repos created then must keep opening after the key-id
 * change, so this is the fallback candidate in snapshotRepoPasswords().
 */
export function legacySnapshotRepoPassword(oriId: string, serverSecret: string): string {
  return createHmac("sha256", serverSecret).update(`ori-snapshot-repo:${oriId}`).digest("hex");
}

/**
 * Every password that could open a ori's repo, current key first: the keyed
 * derivation, then the pre-key-id un-prefixed one. Deduplicated (they differ only
 * by the prefix, so in practice this is two entries). The first entry that actually
 * opens the repo is the one to use — see resolveRepoPassword().
 */
export function snapshotRepoPasswords(oriId: string, serverSecret: string): string[] {
  return [...new Set([snapshotRepoPassword(oriId, serverSecret), legacySnapshotRepoPassword(oriId, serverSecret)])];
}

/**
 * Resolve the password that actually OPENS an existing repo (OPEN-DECISIONS #1).
 *
 * Repos created before the key-id change used the un-prefixed derivation; repos
 * created since use the current keyed one. A single derived value cannot know
 * which, so probe the repo with each candidate (`restic cat config`, read-only,
 * lock-free) and return the first that opens it. A repo that does not exist yet
 * (nothing at this location — "no-repo") gets the CURRENT keyed derivation, which
 * the first init will use.
 *
 * `s3` carries the per-ori session credentials; the repo must be reachable from
 * wherever this runs (the control plane's endpoint, not the ori-facing one).
 */
export async function resolveRepoPassword(opts: {
  oriId: string;
  serverSecret: string;
  repo: string;
  s3: ResticS3Credentials;
  bin?: string;
}): Promise<string> {
  for (const password of snapshotRepoPasswords(opts.oriId, opts.serverSecret)) {
    const probe = new Restic({ bin: opts.bin, repo: opts.repo, password, s3: opts.s3 });
    try {
      const status = await probe.probePassword();
      if (status === "ok" || status === "no-repo") return password;
    } finally {
      await probe.close();
    }
  }
  // Unreachable in practice (candidates are deduped); the current derivation is the
  // safe default for a repo that has never been probed as openable.
  return snapshotRepoPassword(opts.oriId, opts.serverSecret);
}

/** restic failed. `stderr` is always carried: it is the only thing that makes a failure fixable. */
export class ResticError extends Error {
  readonly args: string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: string, args: string[], exitCode: number, stdout: string, stderr: string) {
    const tail = stderr.trim() || stdout.trim();
    super(`restic ${command} failed (exit ${exitCode}): ${tail || "(no output)"}`);
    this.name = "ResticError";
    this.args = args;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** A promise that settles to undefined after ms, plus a way to cancel the timer. */
function withTimeout(ms: number): { promise: Promise<undefined>; clear: () => void } {
  let clear: () => void = () => {};
  const promise = new Promise<undefined>((resolve) => {
    // The timer type is inferred from the call, not from `ReturnType<typeof
    // setTimeout>`: bun-types and @types/node overload the global differently,
    // so the last overload's return type does not match the resolved overload.
    const timer = setTimeout(() => resolve(undefined), ms);
    clear = () => clearTimeout(timer);
  });
  return { promise, clear };
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

/**
 * The default cache dir for a repo: a persistent, per-repo directory under
 * /var/cache/ori-restic, keyed by a hash of the repo URL. Sharing is the point —
 * every control-plane process and every guest instance that touches the same
 * repo must see the same cache, or each 60s snapshot and each restore pays the
 * cost of re-downloading the repo config + index from object storage. restic
 * itself keys caches by repo id internally, but a single shared root for every
 * repo would let one ori's index traffic evict another's; the per-repo subdir
 * keeps them apart.
 *
 * Where no writable persistent location exists (a dev machine without
 * /var/cache, or an operator pointing RESTIC_CACHE_DIR at a read-only path) we
 * fall back to a per-instance temp dir that close() deletes. The cache is a cost
 * optimization, not a correctness requirement: without it restic simply re-fetches
 * the index from object storage on every command, which is the status quo.
 */
function defaultCacheDir(repo: string): { dir: string; ephemeral: boolean } {
  const root = process.env.RESTIC_CACHE_DIR ?? "/var/cache";
  const digest = createHash("sha256").update(repo).digest("hex").slice(0, 16);
  const dir = join(root, "ori-restic", digest);
  try {
    mkdirSync(dir, { recursive: true });
    return { dir, ephemeral: false };
  } catch {
    return { dir: mkdtempSync(join(tmpdir(), "ori-restic-cache-")), ephemeral: true };
  }
}

export class Restic {
  private readonly bin: string;
  private readonly repo: string;
  private readonly password: string;
  private readonly s3: ResticS3Credentials;
  private readonly timeoutMs: number;
  private readonly cacheDir: string;
  private readonly ownsCacheDir: boolean;

  constructor(config: ResticConfig) {
    this.bin = config.bin ?? "restic";
    this.repo = config.repo;
    this.password = config.password;
    this.s3 = config.s3;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    if (config.cacheDir) {
      this.cacheDir = config.cacheDir;
      this.ownsCacheDir = false;
    } else {
      // Persistent per-repo cache. `ownsCacheDir` only ever becomes true for the
      // ephemeral fallback, so a production cache survives across instances.
      const cache = defaultCacheDir(this.repo);
      this.cacheDir = cache.dir;
      this.ownsCacheDir = cache.ephemeral;
    }
  }

  /**
   * Init the repository. Idempotent: a second init on an existing repo is a
   * no-op, not an error (the re-init wording differs across restic versions, so
   * match the stable phrases — "master key and config already initialized" and
   * "repository already exists" — and nothing else).
   */
  async init(): Promise<void> {
    const r = await this.run(["init"]);
    if (r.code === 0) return;
    if (/already initialized|already exists|repository.*exist|file exists/i.test(r.stderr)) return;
    throw new ResticError("init", [], r.code, r.stdout, r.stderr);
  }

  /**
   * Non-destructive password check: does THIS password open the repo? `restic cat
   * config` just fetches and decrypts the config object — no lock is taken, which
   * keeps it usable against a read-only session (fork-restore), and nothing is
   * written. Returns "ok" when the config decrypts, "wrong-password" when the repo
   * exists but this password fails, and "no-repo" when nothing is at this location
   * (a first init would create it). Used by resolveRepoPassword() to pick which
   * derivation opens an existing repo (OPEN-DECISIONS #1).
   */
  async probePassword(): Promise<"ok" | "wrong-password" | "no-repo"> {
    const r = await this.run(["cat", "config", "--no-lock"]);
    if (r.code === 0) return "ok";
    if (/wrong password|no key found/i.test(r.stderr)) return "wrong-password";
    return "no-repo";
  }

  /** Backup paths with optional tags. Returns the new snapshot id + summary. */
  async backup(paths: string[], opts: { tags?: string[] } = {}): Promise<ResticBackupResult> {
    const args = ["backup", "--json"];
    for (const tag of opts.tags ?? []) args.push("--tag", tag);
    args.push(...paths);
    const r = await this.runChecked(args);

    let snapshotId: string | null = null;
    let summary: ResticBackupSummary | null = null;
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      let obj: RawBackupLine;
      try {
        obj = JSON.parse(line) as RawBackupLine;
      } catch {
        continue; // not a JSON status line; ignore
      }
      if (obj.message_type !== "summary") continue;
      if (typeof obj.snapshot_id === "string") snapshotId = obj.snapshot_id;
      summary = {
        filesNew: num(obj.files_new),
        filesChanged: num(obj.files_changed),
        filesUnmodified: num(obj.files_unmodified),
        dirsNew: num(obj.dirs_new),
        dirsChanged: num(obj.dirs_changed),
        dataAdded: num(obj.data_added),
        dataAddedPacked: num(obj.data_added_packed),
        totalBytesProcessed: num(obj.total_bytes_processed),
        totalFilesProcessed: num(obj.total_files_processed),
      };
    }
    if (!snapshotId || !summary) {
      throw new ResticError("backup", args, 0, r.stdout, "backup --json produced no summary with a snapshot_id");
    }
    return { snapshotId, summary };
  }

  /** List all snapshots, oldest first (restic's own ordering). */
  async snapshots(): Promise<ResticSnapshot[]> {
    const r = await this.runChecked(["snapshots", "--json"]);
    const arr = JSON.parse(r.stdout) as RawSnapshot[];
    return arr.map((s) => ({
      id: s.id,
      shortId: s.short_id,
      time: s.time,
      tree: s.tree,
      paths: s.paths ?? [],
      hostname: s.hostname,
      username: s.username,
      tags: s.tags ?? [],
      parent: s.parent ?? null,
    }));
  }

  /** List the whole tree of a snapshot as mapped nodes ({path, kind, size}). */
  async ls(snapshotId: string): Promise<ResticNode[]> {
    const r = await this.runChecked(["ls", "--json", snapshotId]);
    const nodes: ResticNode[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      let obj: RawLsLine;
      try {
        obj = JSON.parse(line) as RawLsLine;
      } catch {
        continue;
      }
      if (obj.message_type !== "node") continue;
      nodes.push({
        path: String(obj.path),
        name: String(obj.name),
        kind: obj.type === "dir" ? "dir" : obj.type === "symlink" ? "symlink" : "file",
        size: typeof obj.size === "number" ? obj.size : 0,
        mode: typeof obj.mode === "number" ? obj.mode : undefined,
      });
    }
    return nodes;
  }

  /**
   * Stream a path out of a snapshot: a file's bytes, or a folder as a tar.
   * Consume `body`, then await `wait()` to surface failures.
   */
  async dump(snapshotId: string, path: string): Promise<ResticDump> {
    const args = ["dump", snapshotId, path];
    const proc = Bun.spawn({ cmd: [this.bin, "-r", this.repo, ...args], env: this.env(), stdout: "pipe", stderr: "pipe" });
    const stderrP = new Response(proc.stderr).text();
    const timer = withTimeout(this.timeoutMs);

    return {
      body: proc.stdout as ReadableStream<Uint8Array>,
      wait: async () => {
        const code = await Promise.race([proc.exited, timer.promise]);
        if (code === undefined) {
          timer.clear();
          proc.kill();
          throw new ResticError("dump", args, -1, "", `restic dump timed out after ${this.timeoutMs}ms`);
        }
        timer.clear();
        if (code !== 0) {
          throw new ResticError("dump", args, code, "", await stderrP);
        }
      },
    };
  }

  /** Buffered convenience over dump(): a file's bytes, or a folder as tar. */
  async dumpBytes(snapshotId: string, path: string): Promise<Uint8Array> {
    const d = await this.dump(snapshotId, path);
    const bytes = new Uint8Array(await new Response(d.body).arrayBuffer());
    await d.wait();
    return bytes;
  }

  /** Restore a snapshot into targetDir. restic lays out <target><original absolute path>. */
  async restore(snapshotId: string, targetDir: string): Promise<void> {
    // --no-lock, deliberately. A restore only READS the repo, so the lock restic takes by
    // default is a write it does not need — and a fork restores from its parent's repo with
    // READ-ONLY credentials (OPEN-DECISIONS #2, resolved), under which the lock write is
    // "Access Denied" and the restore dies before it reads anything. --no-lock is restic's
    // own answer for read-only repositories, verified on both the image's 0.16.4 and the
    // host's 0.19.x against a real read-only session policy.
    await this.runChecked(["restore", snapshotId, "--target", targetDir, "--no-lock"]);
  }

  /**
   * `forget` with a retention policy. restic applies the keep policies as a
   * union — a snapshot survives if ANY of them wants it — so `keepLast: 50,
   * keepDaily: 7` is exactly the "keep the last 50, plus one per day for the
   * last week" the reaper wants. With no options this keeps everything (forget
   * on an empty repo is a no-op, so it is safe to call before the first backup).
   */
  async forget(opts: ResticForgetOptions = {}): Promise<ResticForgetResult> {
    const args = ["forget", "--json"];
    if (opts.keepLast !== undefined) args.push("--keep-last", String(opts.keepLast));
    if (opts.keepDaily !== undefined) args.push("--keep-daily", String(opts.keepDaily));
    const r = await this.runChecked(args);
    const groups = JSON.parse(r.stdout) as RawForgetGroup[];
    // restic emits null (not []) for a group's `remove` when nothing is dropped.
    return {
      keepIds: groups.flatMap((g) => (g.keep ?? []).map((s) => s.short_id)),
      removeIds: groups.flatMap((g) => (g.remove ?? []).map((s) => s.short_id)),
      removeFullIds: groups.flatMap((g) => (g.remove ?? []).map((s) => s.id)),
      groups: groups.length,
    };
  }

  /**
   * Reclaim storage: delete pack files no snapshot references. This is the
   * EXPENSIVE half of retention (it rewrites the repo's pack files), so it
   * belongs on a far slower schedule than forget — forget runs every reaper
   * tick, prune should run on a cron. Deliberately not called by the retention
   * helper: applying both every tick would make retention the dominant cost.
   */
  async prune(): Promise<void> {
    await this.runChecked(["prune"]);
  }

  /** Remove the ephemeral fallback cache dir, when we created one. A persistent cache is never deleted here. */
  async close(): Promise<void> {
    if (this.ownsCacheDir) await rm(this.cacheDir, { recursive: true, force: true });
  }

  /* ----------------------------- internals ----------------------------- */

  /** Child env: real S3 creds + the password, never on the command line. */
  private env(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      AWS_ACCESS_KEY_ID: this.s3.accessKey,
      AWS_SECRET_ACCESS_KEY: this.s3.secretKey,
      // An STS session token is required alongside a temporary access key;
      // restic's s3 backend honors it via AWS_SESSION_TOKEN. Absent for static
      // credentials, where setting the var would be harmless but noisy.
      ...(this.s3.sessionToken ? { AWS_SESSION_TOKEN: this.s3.sessionToken } : {}),
      AWS_REGION: this.s3.region ?? "us-east-1",
      RESTIC_PASSWORD: this.password,
      RESTIC_CACHE_DIR: this.cacheDir,
    };
  }

  private async run(args: string[]): Promise<CmdResult> {
    const proc = Bun.spawn({
      cmd: [this.bin, "-r", this.repo, ...args],
      env: this.env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const readOut = new Response(proc.stdout).text();
    const readErr = new Response(proc.stderr).text();
    const timer = withTimeout(this.timeoutMs);

    const code = await Promise.race([proc.exited, timer.promise]);
    if (code === undefined) {
      timer.clear();
      proc.kill();
      throw new ResticError(args[0] ?? "restic", args, -1, "", `restic timed out after ${this.timeoutMs}ms`);
    }
    timer.clear();
    const [stdout, stderr] = await Promise.all([readOut, readErr]);
    return { code, stdout, stderr };
  }

  /** run() that throws ResticError on a non-zero exit. */
  private async runChecked(args: string[]): Promise<CmdResult> {
    const r = await this.run(args);
    if (r.code !== 0) {
      throw new ResticError(args[0] ?? "restic", args, r.code, r.stdout, r.stderr);
    }
    return r;
  }
}
