import { mkdir, writeFile, rename, realpath, lstat, readlink, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateEnvObject, validateSecretPath, type OriId, type SecretFile } from "@ori/contract";
import { FileError, resolveFilePath } from "./file";

export const DEFAULT_ENV_FILE = "/etc/ori.env";
export const DEFAULT_WORK_DIR = "/home/user";

export interface EnvInput {
  oriId: OriId;
  vars?: Record<string, string>;
  files?: SecretFile[];
  envFile?: string;
  workDir?: string;
}

/**
 * Quote a value so `KEY='...'` round-trips exactly when bash sources the file:
 * single-quote everything and escape embedded quotes as `'\''`. Handles
 * newlines, `$`, backslashes, double quotes and backticks — none can corrupt.
 */
export function bashQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Serialize an env map to deterministic `KEY=VALUE` lines (sorted keys). */
export function serializeEnv(vars: Record<string, string>): string {
  return Object.keys(vars)
    .sort()
    .map((k) => `${k}=${bashQuote(vars[k])}`)
    .join("\n") + (Object.keys(vars).length > 0 ? "\n" : "");
}

/**
 * Atomically write the env file: write a temp file in the same directory and
 * rename it over the target, so a half-written /etc/ori.env (which every login
 * shell and systemd unit sources) never exists. Mode 0644.
 */
export async function writeEnvFile(envFile: string, content: string): Promise<void> {
  const dir = dirname(envFile);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.ori.env.tmp.${process.pid}.${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, content, { mode: 0o644 });
    await rename(tmp, envFile);
  } catch (e) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw e;
  }
}

/** Validate the vars map against the contract's documented limits. */
export function validateVars(vars: Record<string, string> | undefined): { ok: true } | { ok: false; message: string } {
  const v = validateEnvObject(vars);
  if (!v.ok) return { ok: false, message: v.message };
  return { ok: true };
}

/**
 * Write one secret file relative to the work dir (mode 0600, parents created).
 * Returns "skip" when the path is absolute or escapes via `..` (per the docs,
 * those are skipped, not fatal) and "reject" when a resolved symlink would
 * carry the write outside the work dir (same guard as T-P4-03).
 */
export async function writeSecretFile(
  workDir: string,
  file: SecretFile,
): Promise<{ kind: "written" | "skip" }> {
  const p = validateSecretPath(file.path);
  if (!p.ok) return { kind: "skip" }; // absolute / .. / . escapes: skip per docs

  const target = await resolveFilePath(workDir, file.path, true); // throws FileError on symlink escape

  // Re-check the resolved path: if the final component is a symlink pointing
  // outside the work dir, writing would follow it — reject like T-P4-03.
  const baseReal = await realpath(workDir);
  try {
    const lst = await lstat(target);
    if (lst.isSymbolicLink()) {
      const linkTarget = await readlink(target);
      const resolvedLink = join(dirname(target), linkTarget);
      const linkReal = await realpath(resolvedLink);
      const sep = process.platform === "win32" ? "\\" : "/";
      if (linkReal !== baseReal && !linkReal.startsWith(`${baseReal}${sep}`)) {
        throw new FileError(400, `path escapes work dir: ${file.path}`);
      }
    }
  } catch (e) {
    if (e instanceof FileError) throw e;
    // lstat failed (ENOENT) -> file is fresh, no symlink to follow
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, file.contents, { mode: 0o600 });
  return { kind: "written" };
}

/** Apply the whole /env update: env file (atomic) + secret files. */
export async function applyEnv(input: EnvInput): Promise<void> {
  const vars = input.vars ?? {};
  const check = validateVars(vars);
  if (!check.ok) throw new FileError(400, check.message);

  const envFile = input.envFile ?? DEFAULT_ENV_FILE;
  await writeEnvFile(envFile, serializeEnv(vars));

  const workDir = input.workDir ?? DEFAULT_WORK_DIR;
  for (const f of input.files ?? []) {
    await writeSecretFile(workDir, f);
  }
}
