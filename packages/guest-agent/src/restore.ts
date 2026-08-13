import { join } from "node:path";
import { mkdir, readFile, rm, readdir, stat, lstat, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Restic } from "@ori/api/snapshots/restic";
import type { SnapshotStorageConfig } from "./snapshot";
import { DEFAULT_VOLUMES_DIR } from "./snapshot";

/**
 * POST /restore — put a ori's disk back from a restic snapshot.
 *
 * Ori's promise is precise about what survives a stop/resume:
 * "Files, installed packages, and enabled systemd services do. Hand-run processes do not."
 * So restoring the work dir is only the first third of the job. The sysdiff captured at
 * snapshot time carries the system delta, and this re-applies it:
 *
 *   etc-diff/          -> copied back over /etc
 *   enabled-units.txt  -> systemctl enable (and start) each unit
 *   crontabs.txt       -> reinstalled per user
 *   dpkg-selections.txt-> package reconciliation, see the caveat below
 *
 * Deliberately NOT restored: machine identity (the image regenerates hostname, ssh host
 * keys and machine-id per ori by design — restoring them would give every fork of a ori
 * the same SSH identity), and hand-run processes, which the published spec documents as not surviving.
 *
 * PACKAGE CAVEAT, and it is a real limitation rather than a bug: restic restores files,
 * not installed packages. Reinstating packages means `dpkg --set-selections` followed by
 * an apt run, which needs a working apt and network and can take minutes. It is attempted
 * when `reconcilePackages` is set and apt is present, and is NEVER fatal — a resume that
 * fails because a mirror is down would be worse than a resume whose package set is
 * incomplete and reported as such. The result says what actually happened.
 */

export interface RestoreStorage extends SnapshotStorageConfig {}

export interface RestoreInput {
  oriId: string;
  /** restic snapshot id, or "latest". */
  snapshotRef: string;
  storage: RestoreStorage;
  workDir: string;
  volumesDir?: string;
  resticBin?: string;
  /** Attempt `dpkg --set-selections` + apt. Off in tests; on in a real ori. */
  reconcilePackages?: boolean;
  /** T-P5-07 owns the actual scrub; accepted here so the wire shape is stable. */
  scrubEnv?: boolean;
  /** Injected for tests. */
  runner?: (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface RestoreResult {
  ok: true;
  type: "restore.completed";
  snapshotRef: string;
  /** Files restored into the work dir. */
  restoredFiles: number;
  /** Units re-enabled, and the ones that could not be. */
  unitsEnabled: string[];
  unitsFailed: string[];
  /** /etc entries copied back. */
  etcRestored: number;
  crontabsRestored: number;
  /** Credential paths removed because --no-env was requested. */
  scrubbed: string[];
  /** What happened to packages: 'skipped' | 'unavailable' | 'reconciled' | 'failed'. */
  packages: "skipped" | "unavailable" | "reconciled" | "failed";
  notes: string[];
}

async function run(
  cmd: string[],
  runner?: RestoreInput["runner"],
  timeoutMs = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (runner) return runner(cmd);
  let proc;
  try {
    proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  } catch {
    return { code: -1, stdout: "", stderr: "spawn failed" };
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/**
 * Copy a restored tree into place, skipping sockets, FIFOs and device nodes.
 *
 * restic faithfully recreates everything it captured, and a live ori's home directory
 * routinely holds unix sockets (an editor server, a dev server, ssh-agent). node's cp
 * throws ENXIO on the first one and the whole restore dies — which presented as a resume
 * failing with "no such device or address" and no clue which file. Regular files,
 * directories and symlinks are what a restore is actually for.
 */
async function copyTree(from: string, to: string, notes: string[]): Promise<void> {
  let skipped = 0;
  await cp(from, to, {
    recursive: true,
    force: true,
    // dereference:false keeps symlinks as symlinks rather than copying their targets.
    dereference: false,
    filter: async (src) => {
      try {
        const st = await lstat(src);
        if (st.isFile() || st.isDirectory() || st.isSymbolicLink()) return true;
        skipped += 1;
        return false;
      } catch {
        return false;
      }
    },
  });
  if (skipped > 0) notes.push(`skipped ${skipped} socket/fifo/device entr(ies) during restore`);
}

/** Count files under a directory, following nothing. */
async function countFiles(dir: string): Promise<number> {
  let n = 0;
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else n += 1;
    }
  };
  await walk(dir);
  return n;
}

export async function runRestore(input: RestoreInput): Promise<RestoreResult> {
  const notes: string[] = [];
  const restic = new Restic({
    bin: input.resticBin ?? "restic",
    repo: input.storage.repoUrl,
    password: input.storage.password,
    s3: {
      endpoint: input.storage.endpoint,
      accessKey: input.storage.credentials.accessKeyId,
      secretKey: input.storage.credentials.secretAccessKey,
      sessionToken: input.storage.credentials.sessionToken,
      region: input.storage.region,
    },
  });

  // Restore into a staging dir first. restic recreates absolute paths under --target, so a
  // snapshot of /home/user lands at <staging>/home/user. Restoring straight over the live
  // work dir would leave a half-written tree if restic failed midway.
  const staging = join(tmpdir(), `ori-restore-${input.oriId}-${Date.now().toString(36)}`);
  await mkdir(staging, { recursive: true });

  try {
    await restic.restore(input.snapshotRef, staging);

    // 1. the work dir
    const stagedWork = join(staging, input.workDir);
    let restoredFiles = 0;
    if (await stat(stagedWork).then(() => true).catch(() => false)) {
      await mkdir(input.workDir, { recursive: true });
      await copyTree(stagedWork, input.workDir, notes);
      restoredFiles = await countFiles(stagedWork);
    } else {
      notes.push(`snapshot contained no ${input.workDir}`);
    }

    // 1b. --no-env scrub. Runs the MOMENT the disk is on the ori and before any unit is
    //     enabled or the control plane can mark the ori ready, because the whole point is
    //     that a no-env ori never becomes reachable holding its parent's credentials
    //    . Doing it later would leave a window where it did.
    const scrubbed = input.scrubEnv ? await scrubCredentials(input.workDir, notes) : [];

    // 2. docker volumes, when the snapshot had them
    const volumes = input.volumesDir ?? DEFAULT_VOLUMES_DIR;
    const stagedVolumes = join(staging, volumes);
    if (await stat(stagedVolumes).then(() => true).catch(() => false)) {
      await mkdir(volumes, { recursive: true });
      await copyTree(stagedVolumes, volumes, notes);
    }

    // 3. the sysdiff. Find the tar wherever restic put it, then unpack it.
    const sysdiffTar = await findSysdiffTar(staging);
    const result: RestoreResult = {
      ok: true,
      type: "restore.completed",
      snapshotRef: input.snapshotRef,
      restoredFiles,
      unitsEnabled: [],
      unitsFailed: [],
      etcRestored: 0,
      crontabsRestored: 0,
      scrubbed,
      packages: "skipped",
      notes,
    };
    if (!sysdiffTar) {
      notes.push("no sysdiff.tar in the snapshot; system delta not re-applied");
      return result;
    }

    const unpacked = join(staging, "sysdiff");
    await mkdir(unpacked, { recursive: true });
    const untar = await run(["tar", "-xf", sysdiffTar, "-C", unpacked], input.runner);
    if (untar.code !== 0) {
      notes.push(`sysdiff untar failed: ${untar.stderr.trim() || untar.code}`);
      return result;
    }
    // The tar holds one directory (ori-sysdiff-<id>); descend into it when present.
    const root = await sysdiffRoot(unpacked);

    result.etcRestored = await restoreEtc(root, notes);
    const units = await restoreUnits(root, input.runner, notes);
    result.unitsEnabled = units.enabled;
    result.unitsFailed = units.failed;
    result.crontabsRestored = await restoreCrontabs(root, input.runner, notes);
    result.packages = await reconcilePackages(root, input, notes);

    return result;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Locate sysdiff.tar anywhere under the staging tree. */
async function findSysdiffTar(dir: string): Promise<string | null> {
  let found: string | null = null;
  const walk = async (d: string): Promise<void> => {
    if (found) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found) return;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/ori-sysdiff-.*\.tar$/.test(e.name) || e.name === "sysdiff.tar") found = p;
    }
  };
  await walk(dir);
  return found;
}

async function sysdiffRoot(unpacked: string): Promise<string> {
  const entries = await readdir(unpacked, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory());
  // A single wrapping directory means the tar preserved ori-sysdiff-<id>/.
  if (dirs.length === 1 && entries.length === 1) return join(unpacked, dirs[0].name);
  return unpacked;
}

/**
 * Copy the captured /etc delta back. Machine identity is skipped even if a snapshot somehow
 * carries it: restoring ssh host keys would give every fork of a ori the same SSH identity,
 * which is the bug the image's per-boot keygen exists to prevent.
 */
const ETC_NEVER_RESTORE = [/^ssh\/ssh_host_/, /^machine-id$/, /^hostname$/, /^hosts$/];

async function restoreEtc(root: string, notes: string[]): Promise<number> {
  const src = join(root, "etc-diff");
  if (!(await stat(src).then(() => true).catch(() => false))) return 0;
  let n = 0;
  const walk = async (rel: string): Promise<void> => {
    const here = rel ? join(src, rel) : src;
    const entries = await readdir(here, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const childRel = rel ? join(rel, e.name) : e.name;
      if (ETC_NEVER_RESTORE.some((re) => re.test(childRel))) {
        notes.push(`skipped machine identity /etc/${childRel}`);
        continue;
      }
      if (e.isDirectory()) {
        await walk(childRel);
      } else {
        const dest = join("/etc", childRel);
        try {
          await mkdir(join("/etc", rel), { recursive: true });
          await cp(join(src, childRel), dest, { force: true });
          n += 1;
        } catch (err) {
          notes.push(`could not restore /etc/${childRel}: ${(err as Error).message}`);
        }
      }
    }
  };
  await walk("");
  return n;
}

/** Re-enable (and start) the units that were enabled when the snapshot was taken. */
async function restoreUnits(
  root: string,
  runner: RestoreInput["runner"],
  notes: string[],
): Promise<{ enabled: string[]; failed: string[] }> {
  const enabled: string[] = [];
  const failed: string[] = [];
  const text = await readFile(join(root, "enabled-units.txt"), "utf8").catch(() => "");
  if (!text || text.startsWith("#")) return { enabled, failed };

  for (const line of text.split("\n")) {
    const unit = line.trim().split(/\s+/)[0];
    if (!unit || unit.startsWith("#") || !unit.includes(".")) continue;
    // enable --now so a service the user had running comes back. This is the documented
    // difference between an enabled unit (survives) and a hand-run process (does not).
    const r = await run(["systemctl", "enable", "--now", unit], runner, 30_000);
    if (r.code === 0) enabled.push(unit);
    else failed.push(unit);
  }
  if (failed.length > 0) notes.push(`${failed.length} unit(s) could not be enabled`);
  return { enabled, failed };
}

async function restoreCrontabs(
  root: string,
  runner: RestoreInput["runner"],
  notes: string[],
): Promise<number> {
  const text = await readFile(join(root, "crontabs.txt"), "utf8").catch(() => "");
  if (!text || text.includes("# no crontabs found")) return 0;

  // The snapshot writes sections headed `--- <absolute path> ---`, covering /etc/crontab,
  // /etc/cron.d/* and the per-user spool under /var/spool/cron/crontabs. Restoring means
  // writing each section back to its own path; a per-user spool file is installed with
  // `crontab -u` so cron notices it, rather than dropped into the spool by hand.
  const sections = text.split(/^--- (.+) ---$/m);
  let n = 0;
  for (let i = 1; i < sections.length; i += 2) {
    const path = sections[i]!.trim();
    const body = sections[i + 1] ?? "";
    if (!path || body.trim().length === 0) continue;

    const spool = path.match(/^\/var\/spool\/cron\/crontabs\/(.+)$/);
    try {
      if (spool) {
        const user = spool[1]!;
        const tmp = join(tmpdir(), `ori-crontab-${user}-${Date.now().toString(36)}`);
        await Bun.write(tmp, body.replace(/^\n/, ""));
        const r = await run(["crontab", "-u", user, tmp], runner, 15_000);
        await rm(tmp, { force: true }).catch(() => {});
        if (r.code === 0) n += 1;
        else notes.push(`crontab for ${user} not restored`);
      } else {
        await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
        await Bun.write(path, body.replace(/^\n/, ""));
        n += 1;
      }
    } catch (err) {
      notes.push(`could not restore ${path}: ${(err as Error).message}`);
    }
  }
  return n;
}

/**
 * Reinstate the package set. Never fatal: a resume that fails because a mirror is
 * unreachable is worse than one whose package set is incomplete and says so.
 */
async function reconcilePackages(
  root: string,
  input: RestoreInput,
  notes: string[],
): Promise<RestoreResult["packages"]> {
  if (!input.reconcilePackages) return "skipped";
  const selections = await readFile(join(root, "dpkg-selections.txt"), "utf8").catch(() => "");
  if (!selections || selections.startsWith("#")) return "unavailable";

  const probe = await run(["sh", "-lc", "command -v apt-get && command -v dpkg"], input.runner, 10_000);
  if (probe.code !== 0) {
    notes.push("apt-get/dpkg unavailable; package set not reconciled");
    return "unavailable";
  }

  const tmp = join(tmpdir(), `ori-selections-${Date.now().toString(36)}`);
  await Bun.write(tmp, selections);
  const set = await run(["sh", "-lc", `dpkg --set-selections < ${JSON.stringify(tmp)}`], input.runner, 60_000);
  if (set.code !== 0) {
    notes.push("dpkg --set-selections failed; package set not reconciled");
    await rm(tmp, { force: true }).catch(() => {});
    return "failed";
  }
  const upgrade = await run(
    ["sh", "-lc", "DEBIAN_FRONTEND=noninteractive apt-get -y dselect-upgrade"],
    input.runner,
    600_000,
  );
  await rm(tmp, { force: true }).catch(() => {});
  if (upgrade.code !== 0) {
    notes.push("apt-get dselect-upgrade did not complete; package set may be incomplete");
    return "failed";
  }
  return "reconciled";
}


/**
 * Remove the owner's credentials from a restored disk. `resume --no-env` and
 * `fork --no-env` exist so a ori can be handed to someone else: the plan's platform guide
 * is explicit that "a no-env ori receives none of your account's secrets or credentials and
 * cannot act on your account or other oris". A restore replays the parent's home
 * directory, so without this a fork would arrive holding the parent's SSH key, GitHub
 * token and model API keys.
 *
 * Removes rather than empties: an empty ~/.ssh/id_ed25519 is a file an agent may
 * cheerfully overwrite and then "fix" by regenerating, whereas an absent one fails loudly.
 */
const SCRUB_RELATIVE = [
  ".ssh",              // the owner's keys AND authorized_keys — a fork must not admit the parent
  ".config/gh",        // GitHub CLI token
  ".config/ori",       // this platform's own CLI token
  ".claude",
  ".claude.json",
  ".codex",
  ".netrc",
  ".aws",
  ".docker/config.json",
  ".git-credentials",
  ".npmrc",            // may carry a registry auth token
  ".pypirc",
];

/** Absolute paths scrubbed as well; /etc/ori.env is where injected secrets land. */
const SCRUB_ABSOLUTE = ["/etc/ori.env"];

export async function scrubCredentials(workDir: string, notes: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const rel of SCRUB_RELATIVE) {
    const p = join(workDir, rel);
    try {
      if (await stat(p).then(() => true).catch(() => false)) {
        await rm(p, { recursive: true, force: true });
        removed.push(rel);
      }
    } catch (err) {
      // A credential we cannot delete is a hard problem: the ori must not become reachable
      // still holding it. Surface it loudly rather than continuing quietly.
      notes.push(`SCRUB FAILED for ${rel}: ${(err as Error).message}`);
      throw new Error(`--no-env scrub could not remove ${rel}`);
    }
  }
  for (const abs of SCRUB_ABSOLUTE) {
    try {
      if (await stat(abs).then(() => true).catch(() => false)) {
        await rm(abs, { force: true });
        removed.push(abs);
      }
    } catch (err) {
      notes.push(`SCRUB FAILED for ${abs}: ${(err as Error).message}`);
      throw new Error(`--no-env scrub could not remove ${abs}`);
    }
  }
  notes.push(`--no-env scrub removed ${removed.length} credential path(s)`);
  return removed;
}
