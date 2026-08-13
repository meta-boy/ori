import type { OriId } from "@ori/contract";
import { asLoginUser } from "./user";

/**
 * P12-04 — the in-ori agent harness: run a provider CLI (codex / claude-code) against the
 * ori's own credentials and stream its output as drainable lines.
 *
 * Design choices:
 *  - TEXT-mode passthrough. The provider CLI's stdout/stderr lines become `response` events
 *    verbatim. No provider-specific JSON parsing: any CLI that prints progress works, and a
 *    format change upstream cannot break the harness.
 *  - Detached process group, killed as a group on interrupt — the same pattern exec.ts uses
 *    for timeouts, so interrupt cannot leave an orphaned agent holding the box.
 *  - The prompt travels as a single argv element (never through a shell), so shell
 *    metacharacters in user text are data, not syntax.
 *  - The control plane drains lines with `from` (an index into the buffer), so a restart of
 *    the control plane loses only in-flight deltas, never the re-pull.
 */

export interface PromptStartInput {
  oriId: OriId;
  promptId: string;
  /** codex | claude-code | claude (claude is an alias for claude-code). */
  provider: string;
  model?: string | null;
  reasoningEffort?: string | null;
  prompt: string;
  workDir?: string;
}

export interface PromptLine {
  stream: "stdout" | "stderr";
  text: string;
}

export interface PromptRunState {
  promptId: string;
  provider: string;
  status: "queued" | "running" | "finished" | "failed";
  done: boolean;
  exitCode: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Total lines captured so far; drain with `from`. */
  lineCount: number;
}

export class ProviderNotConfigured extends Error {
  constructor(provider: string) {
    super(`provider "${provider}" is not installed in this ori (install it and log in inside the ori first)`);
    this.name = "ProviderNotConfigured";
  }
}

/** Hard cap on captured lines per session; a runaway agent must not grow guest memory. */
export const MAX_LINES = 200_000;

export class PromptSession {
  readonly promptId: string;
  readonly provider: string;
  readonly lines: PromptLine[] = [];
  status: PromptRunState["status"] = "queued";
  exitCode: number | null = null;
  error: string | null = null;
  startedAt: string | null = null;
  finishedAt: string | null = null;
  private proc: { pid: number; exited: Promise<number | null>; kill(sig?: string | number): void } | null = null;
  private finishedResolve: (() => void) | null = null;

  constructor(promptId: string, provider: string) {
    this.promptId = promptId;
    this.provider = provider;
  }

  get done(): boolean {
    return this.status === "finished" || this.status === "failed";
  }

  state(): PromptRunState {
    return {
      promptId: this.promptId,
      provider: this.provider,
      status: this.status,
      done: this.done,
      exitCode: this.exitCode,
      error: this.error,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      lineCount: this.lines.length,
    };
  }

  /** Append a captured line (stdout or stderr). */
  push(stream: "stdout" | "stderr", text: string): void {
    this.lines.push({ stream, text });
  }

  /** Resolves when the process exits (or immediately if already done). */
  exited(): Promise<void> {
    if (this.done) return Promise.resolve();
    return new Promise((resolve) => {
      this.finishedResolve = resolve;
    });
  }

  /** Kill the whole process group; used by interrupt. */
  kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
    if (this.proc?.pid) {
      try {
        process.kill(-this.proc.pid, signal); // the group, not just the child
      } catch {
        try {
          this.proc.kill(signal);
        } catch {
          // already gone
        }
      }
    }
  }

  /** Called by the runner when the process exits. */
  finish(exitCode: number | null, error?: string): void {
    if (this.done) return;
    this.exitCode = exitCode;
    this.error = error ?? null;
    this.finishedAt = new Date().toISOString();
    this.status = error ? "failed" : exitCode === 0 ? "finished" : "failed";
    if (this.finishedResolve) {
      this.finishedResolve();
      this.finishedResolve = null;
    }
  }

  attach(proc: { pid: number; exited: Promise<number | null>; kill(sig?: string | number): void }): void {
    this.proc = proc;
    this.status = "running";
    this.startedAt = new Date().toISOString();
  }
}

/** Map a provider to the CLI invocation. The prompt is one argv element, never shell text. */
export function providerCommand(input: PromptStartInput): string[] {
  const { provider, model, reasoningEffort, prompt } = input;
  switch (provider) {
    case "codex": {
      const args = ["codex", "exec"];
      if (model) args.push("--model", model);
      if (reasoningEffort) args.push("--reasoning-effort", reasoningEffort);
      args.push(prompt);
      return args;
    }
    case "claude":
    case "claude-code": {
      const args = ["claude", "-p", "--output-format", "text"];
      if (model) args.push("--model", model);
      args.push(prompt);
      return args;
    }
    default:
      throw new ProviderNotConfigured(provider);
  }
}

/** Resolve a provider binary's presence via `command -v` (as the login user, so PATH is theirs). */
export async function providerInstalled(provider: string): Promise<boolean> {
  const bin = provider === "codex" ? "codex" : "claude";
  const p = Bun.spawn({ cmd: asLoginUser(["bash", "-lc", `command -v ${bin} >/dev/null 2>&1`]), stdout: "ignore", stderr: "ignore" });
  return (await p.exited) === 0;
}

/**
 * The prompt session registry for one guest agent. One active prompt at a time keeps the
 * semantics simple: a second start while one is running is refused with a conflict, and
 * interrupt kills whichever session is active.
 */
export class PromptRegistry {
  private sessions = new Map<string, PromptSession>();

  get(promptId: string): PromptSession | undefined {
    return this.sessions.get(promptId);
  }

  get active(): PromptSession | undefined {
    for (const s of this.sessions.values()) {
      if (!s.done) return s;
    }
    return undefined;
  }

  add(session: PromptSession): void {
    this.sessions.set(session.promptId, session);
  }

  /** Forget finished sessions (bounded memory): drop all but the newest `keep` done ones. */
  prune(keep = 10): void {
    const done = [...this.sessions.values()].filter((s) => s.done);
    if (done.length > keep) {
      for (const s of done.slice(0, done.length - keep)) this.sessions.delete(s.promptId);
    }
  }
}

/** Run a prompt to completion, pumping stdout/stderr lines into the session. */
export async function runPromptSession(session: PromptSession, cmd: string[], workDir: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: asLoginUser(cmd),
    cwd: workDir,
    detached: true, // own process group so interrupt kills the whole tree
    env: { ...process.env, HOME: workDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  session.attach(proc);

  const pump = async (stream: "stdout" | "stderr") => {
    const readable = proc[stream] as ReadableStream<Uint8Array>;
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        session.push(stream, buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (session.lines.length >= MAX_LINES) {
          session.finish(null, "output exceeded the per-session line cap");
          session.kill("SIGKILL"); // the whole group: the CLI may have spawned children
          return;
        }
      }
    }
    if (buffer.length > 0) session.push(stream, buffer);
  };
  const pumps = Promise.all([pump("stdout"), pump("stderr")]);

  const exitCode = await proc.exited;
  await pumps.catch(() => {});
  session.finish(exitCode ?? 0);
}
