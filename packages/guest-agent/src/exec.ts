import type { ReadableStream } from "node:stream/web";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { CommandRequestSchema, type OriId } from "@ori/contract";
import { asLoginUser } from "./user";

export const DEFAULT_WORK_DIR = "/home/user";
export const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB per stream
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 60;

export interface ExecInput {
  oriId: OriId;
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
  workDir?: string;
}

export interface ExecResult {
  ok: true;
  type: "command.finished";
  success: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cwd: string;
  startedAt: string;
  finishedAt: string;
}

/**
 * Resolve a work-relative cwd against the work dir and reject anything that
 * escapes it. The check runs on the RESOLVED realpath (catches `..` and
 * symlinks), never on the raw string. `undefined`, `""` and `"."` all mean the
 * work dir root; anything else is joined to the work dir, resolved, and
 * rejected unless the resolved real path is inside the work dir.
 *
 * Note: this is deliberately NOT the contract's validateWorkPath — that one
 * rejects "." as a path segment, which is right for secret files but wrong for
 * a cwd where "." legitimately means the work dir itself.
 */
export async function resolveWorkDir(workDir: string, cwd: string | undefined): Promise<string> {
  const rel = cwd ?? "";
  const normalized = rel === "." ? "" : rel;
  const resolved = join(workDir, normalized);
  const [baseReal, targetReal] = await Promise.all([realpath(workDir), realpath(resolved)]);
  const sep = process.platform === "win32" ? "\\" : "/";
  if (targetReal !== baseReal && !targetReal.startsWith(`${baseReal}${sep}`)) {
    throw new Error(`cwd escapes work dir: ${cwd ?? ""}`);
  }
  return targetReal;
}

/** Accumulate a stream up to a byte cap, then keep draining to avoid blocking the child. */
export function createCapture(stream: ReadableStream<Uint8Array>, cap: number) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let parts: string[] = [];
  let length = 0;
  let truncated = false;

  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (!truncated) {
          const remaining = cap - length;
          if (text.length <= remaining) {
            parts.push(text);
            length += text.length;
          } else {
            parts.push(text.slice(0, remaining));
            truncated = true;
            length = cap;
          }
        }
        // After the cap is reached we keep reading and discarding so the child
        // never blocks on a full pipe — truncation must not become a hang.
      }
    } catch {
      // stream error/cancel: stop the pump
    }
  })();

  return {
    /** Resolve once the stream closes (normal completion). */
    done: pump,
    /** Latest captured text + truncation flag, safe to read before `done`. */
    snapshot: () => ({ stdout: parts.join(""), truncated }),
    /** Stop draining early (e.g. a background child keeps the pipe open). */
    cancel: () => {
      try {
        void reader.cancel();
      } catch {
        // already closed
      }
    },
  };
}

/**
 * Run a command through a login shell (`bash -lc`), so /etc/ori.env and the
 * user's profile are sourced and the caller's PATH/env look like a real shell.
 */
export async function runCommand(input: ExecInput): Promise<ExecResult> {
  const workDir = input.workDir ?? DEFAULT_WORK_DIR;
  const timeoutSeconds = Math.min(
    Math.max(input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 1),
    MAX_TIMEOUT_SECONDS,
  );
  const startedAt = new Date().toISOString();

  let cwd: string;
  try {
    cwd = await resolveWorkDir(workDir, input.cwd);
  } catch (e) {
    throw new Error(`invalid cwd: ${(e as Error).message}`);
  }

  const proc = Bun.spawn({
    // Drop root before running a caller's command. The agent is root, so without this every
    // file a command creates in /home/user is root-owned, and the user who ssh's in cannot
    // modify it — `ori exec 'git clone …'` followed by `ori ssh` was a permission error.
    cmd: asLoginUser(["bash", "-lc", input.command]),
    cwd,
    // HOME is the work dir, NOT the cwd: `bash -lc` must source the user's profile and
    // ~/.bashrc from their home, and `~` has to mean the same place regardless of which
    // subdirectory the caller asked to run in. Setting it to cwd made every tool that writes
    // to ~ (git, npm, pip, cargo) scatter its state into whatever subdirectory was passed.
    env: { ...process.env, HOME: workDir },
    detached: true, // own process group so a timeout kills the whole group
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutCap = createCapture(proc.stdout as unknown as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES);
  const stderrCap = createCapture(proc.stderr as unknown as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL"); // kill the group, not just the child
    } catch {
      // already exited
    }
  }, timeoutSeconds * 1000);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  // Wait for the streams to close, but don't let a background child that still
  // holds the pipe hang us forever — give the pumps a moment, then cancel.
  const finished = await Promise.race([
    Promise.all([stdoutCap.done, stderrCap.done]).then(() => true),
    Bun.sleep(200).then(() => false),
  ]);
  if (!finished) {
    stdoutCap.cancel();
    stderrCap.cancel();
    await Promise.race([Promise.all([stdoutCap.done, stderrCap.done]).then(() => true), Bun.sleep(50).then(() => false)]);
  }

  const { stdout: stdoutText, truncated: stdoutTruncated } = stdoutCap.snapshot();
  const { stdout: stderrText, truncated: stderrTruncated } = stderrCap.snapshot();
  const signal = (proc as unknown as { signalCode?: string | null }).signalCode ?? null;

  return {
    ok: true,
    type: "command.finished",
    success: !timedOut && !signal && exitCode === 0,
    exitCode: signal ? null : exitCode,
    signal,
    stdout: stdoutText,
    stderr: stderrText,
    stdoutTruncated,
    stderrTruncated,
    timedOut,
    cwd,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export interface ParsedExecRequest {
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
}

/** Parse + validate a /exec request body; returns an error message when invalid. */
export function parseExecRequest(body: unknown): { ok: true; value: ParsedExecRequest } | { ok: false; message: string } {
  const parsed = CommandRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, message: "invalid exec request" };
  const req = parsed.data;
  if (!req.command || req.command.trim() === "") return { ok: false, message: "command is required" };
  return { ok: true, value: { command: req.command, cwd: req.cwd, timeoutSeconds: req.timeoutSeconds } };
}
