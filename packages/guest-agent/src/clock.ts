/**
 * POST /clock — step the guest's system clock. A snapshot-resumed VM wakes with its
 * clock frozen at suspend time (Firecracker snapshots don't carry the wall clock), so
 * the control plane sends the epoch it wants the guest to believe it is and we
 * `date -s` into place. The agent runs as root, so no sudo is needed.
 */

/** Injectable `date -s` runner so tests fake the system clock set. */
export type ClockRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Default runner: shell out to `date -s @<seconds>` on the real guest. */
export async function defaultClockRunner(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd: args, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

export interface ClockInput {
  epochMs: number;
}

export interface ClockResult {
  ok: true;
  steppedMs: number;
}

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse + validate a /clock request body against the guest's CURRENT clock (`nowMs`).
 * The sanity window is [now - 10 years, now + 1 day]: it bounds what a stale or
 * misconfigured control plane could force rather than trusting either side, and it
 * rejects NaN and negative epochs outright. Returns an error message when invalid.
 */
export function parseClockRequest(
  body: unknown,
  nowMs: number,
): { ok: true; value: ClockInput } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) return { ok: false, message: "invalid JSON" };
  const epochMs = (body as { epochMs?: unknown }).epochMs;
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) {
    return { ok: false, message: "epochMs must be a finite number" };
  }
  if (epochMs < 0) return { ok: false, message: "epochMs must not be negative" };
  if (epochMs < nowMs - TEN_YEARS_MS || epochMs > nowMs + ONE_DAY_MS) {
    return { ok: false, message: "epochMs is outside the acceptable range" };
  }
  return { ok: true, value: { epochMs } };
}

export interface RunClockOptions {
  /** Current guest clock (epoch ms); defaults to Date.now. */
  now?: () => number;
  /** `date -s` runner; defaults to a real spawn. Tests fake it. */
  runDate?: ClockRunner;
}

/** Step the system clock to `epochMs` and report how far the guest clock moved. */
export async function runClock(epochMs: number, options: RunClockOptions = {}): Promise<ClockResult> {
  const now = options.now ?? (() => Date.now());
  const runDate = options.runDate ?? defaultClockRunner;
  const current = now();
  const seconds = Math.floor(epochMs / 1000);
  const result = await runDate(["date", "-s", `@${seconds}`]);
  if (result.code !== 0) {
    throw new Error(`failed to set system clock: ${result.stderr || result.stdout}`);
  }
  return { ok: true, steppedMs: epochMs - current };
}
