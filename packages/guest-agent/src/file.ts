import { readFile, writeFile, mkdir, stat, realpath, lstat, readlink } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { validateSecretPath, type OriId } from "@ori/contract";
import { giveToHomeOwner, homeOwner } from "./user";

export const DEFAULT_WORK_DIR = "/home/user";
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB, decoded bytes

export class FileError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

export interface FileInput {
  oriId: OriId;
  path: string;
  workDir?: string;
}

export interface ReadFileResult {
  ok: true;
  path: string;
  encoding: "utf8" | "base64";
  size: number;
  content: string;
}

export interface WriteFileResult {
  ok: true;
  path: string;
  encoding: "utf8" | "base64";
  size: number;
}

const SEP = process.platform === "win32" ? "\\" : "/";

/** True when `target` is `base` itself or inside it. */
function isInside(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${SEP}`);
}

/** Realpath of the deepest existing ancestor of `p` (inclusive of `p`). */
async function deepestExistingReal(p: string): Promise<string> {
  let probe = p;
  const seen = new Set<string>();
  while (!seen.has(probe)) {
    seen.add(probe);
    try {
      return await realpath(probe);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  throw new Error(`cannot resolve path: ${p}`);
}

/**
 * Resolve a work-relative file path and return its absolute (real) path, or
 * throw FileError. The check runs on the RESOLVED realpath — so `..` and
 * symlink escapes are both caught — and the contract's secret-file validator
 * rejects absolute paths and `.`/`..` segments up front (correct for a file
 * path, unlike the cwd case where `.` is the work dir itself).
 *
 * For a read the final path must exist: a missing file is a 404, but a
 * symlinked parent that would escape is still a 400. For a write the final
 * path may not exist yet — we resolve the deepest existing ancestor so a
 * symlinked parent cannot smuggle the write outside the work dir.
 */
export async function resolveFilePath(workDir: string, rel: string, forWrite: boolean): Promise<string> {
  const v = validateSecretPath(rel);
  if (!v.ok) throw new FileError(400, v.message);

  const baseReal = await realpath(workDir);
  const candidate = join(workDir, rel);

  // The deepest existing ancestor of the candidate must stay inside the work
  // dir; if it is the work dir itself the candidate is a new/empty leaf, which
  // is a 404 on read and a fresh create on write.
  const ancestorReal = await deepestExistingReal(candidate);
  if (!isInside(baseReal, ancestorReal)) {
    throw new FileError(400, `path escapes work dir: ${rel}`);
  }

  if (forWrite) {
    return candidate;
  }

  // Read: the file itself must exist. If only the work dir (or a subdir) exists
  // but not the leaf, it is a missing file, not an escape.
  try {
    const p = await realpath(candidate);
    if (!isInside(baseReal, p)) throw new FileError(400, `path escapes work dir: ${rel}`);
    return p;
  } catch (e) {
    if (e instanceof FileError) throw e;
    throw new FileError(404, `no such file: ${rel}`);
  }
}

/**
 * Strictly decode bytes as UTF-8 or reject (fatal decoder), so reading binary
 * as utf8 errors instead of silently corrupting.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FileError(400, "content is not valid utf8");
  }
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decode a body's content into bytes per encoding; rejects malformed base64. */
export function decodeContent(content: string, encoding: "utf8" | "base64"): Buffer {
  if (encoding === "base64") {
    if (!BASE64_RE.test(content)) throw new FileError(400, "invalid base64 content");
    return Buffer.from(content, "base64");
  }
  return Buffer.from(content, "utf8");
}

/** Validate an encoding query/body value; defaults to utf8. */
export function normalizeEncoding(value: string | undefined | null): "utf8" | "base64" {
  if (value === undefined || value === null || value === "") return "utf8";
  if (value === "utf8" || value === "base64") return value;
  throw new FileError(400, `invalid encoding: ${value}`);
}

/** Read a file from the work dir, enforcing the size cap and utf8 strictness. */
export async function readFileInWorkDir(input: FileInput, encoding: "utf8" | "base64"): Promise<ReadFileResult> {
  const workDir = input.workDir ?? DEFAULT_WORK_DIR;
  const target = await resolveFilePath(workDir, input.path, false);

  const st = await stat(target);
  if (st.isDirectory()) throw new FileError(400, `path is a directory: ${input.path}`);
  if (st.size > MAX_FILE_BYTES) {
    throw new FileError(400, `file exceeds ${MAX_FILE_BYTES} bytes`);
  }

  const bytes = await readFile(target);
  const content = encoding === "base64" ? bytes.toString("base64") : decodeUtf8(bytes);
  return { ok: true, path: input.path, encoding, size: bytes.length, content };
}

/**
 * Create parents, write, and hand the result to the login user.
 *
 * The chown is the whole point. The agent is root, so a plain write leaves a file that is
 * mode 0600 root-owned inside the user's own home — `PUT /files` then `ori ssh` was
 * "Permission denied" on a file the caller had just uploaded. Directories we create need it
 * too, or the user cannot add a sibling next to their own file.
 */
async function writeForLoginUser(workDir: string, target: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o600 });

  const owner = await homeOwner(workDir);
  if (!owner) return; // root-owned home = a bare test dir; nothing to inherit
  await giveToHomeOwner(workDir, target, owner);

  // Walk from the file's directory up to (not including) the work dir. Chowning a directory
  // that already belonged to the user is a harmless no-op, so there is no need to track which
  // ones mkdir actually created.
  const base = await realpath(workDir);
  let dir = dirname(target);
  while (dir.startsWith(`${base}/`)) {
    await giveToHomeOwner(workDir, dir, owner);
    dir = dirname(dir);
  }
}

/** Write a file in the work dir, creating parent dirs, enforcing the cap and 0600. */
export async function writeFileInWorkDir(input: FileInput, content: string, encoding: "utf8" | "base64"): Promise<WriteFileResult> {
  const workDir = input.workDir ?? DEFAULT_WORK_DIR;
  const target = await resolveFilePath(workDir, input.path, true);

  const bytes = decodeContent(content, encoding);
  if (bytes.length > MAX_FILE_BYTES) {
    throw new FileError(400, `content exceeds ${MAX_FILE_BYTES} bytes`);
  }

  // If the final component is a symlink, resolve it and confirm it lands inside
  // the work dir; a write would otherwise follow it (e.g. link -> /etc/passwd).
  try {
    const lst = await lstat(target);
    if (lst.isSymbolicLink()) {
      const linkTarget = await readlink(target);
      const resolvedLink = join(dirname(target), linkTarget);
      const linkReal = await realpath(resolvedLink);
      if (!isInside(await realpath(workDir), linkReal)) {
        throw new FileError(400, `path escapes work dir: ${input.path}`);
      }
      // write through the symlink only if it lands inside
      await writeForLoginUser(workDir, target, bytes);
      return { ok: true, path: input.path, encoding, size: bytes.length };
    }
  } catch (e) {
    if (e instanceof FileError) throw e;
    // lstat failed (ENOENT) -> fine, we create it fresh below.
  }

  await writeForLoginUser(workDir, target, bytes);
  return { ok: true, path: input.path, encoding, size: bytes.length };
}

/**
 * Stream an artifact out of the work dir: a single file's bytes, or a directory
 * as a tar streamed from `tar` running in a login shell. Returns a Node
 * Readable that the guest agent pipes straight to the client — the bytes are
 * never buffered in memory. Callers must destroy() the stream when done.
 */
export async function openArtifact(workDir: string, rel: string): Promise<{ stream: import("node:stream").Readable; contentType: string }> {
  const target = await resolveFilePath(workDir, rel, false);
  const st = await stat(target);
  if (!st.isDirectory()) {
    return { stream: createReadStream(target), contentType: "application/octet-stream" };
  }
  // tar the directory contents; the work-relative path was already validated to
  // stay inside the work dir, so `-C workDir rel` cannot escape.
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const proc = Bun.spawn({
    cmd: ["bash", "-lc", `tar -cf - -C ${quote(workDir)} ${quote(rel)}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  return { stream: proc.stdout as unknown as import("node:stream").Readable, contentType: "application/x-tar" };
}
