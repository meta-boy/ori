import { and, eq } from "drizzle-orm";
import { promptRuns, oris } from "../db/schema";
import type { AppDeps } from "../context";
import { GuestClient, GuestError } from "../guest/client";
import { emitOriEvent } from "./events";

/**
 * P12-05 — the control-plane side of the agent layer: start a prompt run, drain the
 * guest's captured lines into the ori's event stream, and reflect run state in the
 * prompt_runs row and the ori's state (running while an agent works, idle when done).
 *
 * The guest runs the provider CLI and buffers lines; this poller translates them into
 * `response` events (isStreaming true while the run is live, false on the final flush)
 * and `prompt` events for lifecycle (queued/running/finished/failed). Events carry
 * taskId = run id, so a client can follow one prompt through GET /events?type=... or
 * the SDK's waitForPrompt.
 */

export const PROMPT_POLL_MS = 1000;
/** Give up on a guest that is unreachable for this long: the machine is gone or wedged. */
export const PROMPT_UNREACHABLE_GRACE_MS = 60_000;

export interface StartPromptInput {
  provider: string;
  model?: string | null;
  reasoningEffort?: string | null;
  prompt: string;
}

/**
 * Drain a prompt run until it finishes. Fire-and-forget from the prompt route; safe to
 * re-run and safe to lose (a restart leaves the run row not-done, and a client polling
 * promptRunStatus sees the truth either way). Stops when the run row disappears or is
 * marked done by another path (interrupt, stop).
 */
export async function pollPromptRun(deps: AppDeps, oriId: string, runId: string): Promise<void> {
  const row = await deps.db.query.promptRuns.findFirst({ where: eq(promptRuns.id, runId) });
  if (!row || row.done) return;
  const tokens = deps.tokens.get(oriId);
  const oriRow = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriId) });
  if (!tokens || !oriRow?.ip) return;
  const guest = GuestClient.forIp(oriRow.ip, tokens.agentToken);

  let from = 0;
  let unreachableSince: number | null = null;
  let runningEmitted = false;

  for (;;) {
    // The run row is the single source of truth for "should I keep going": interrupt marks
    // it done, stop/delete removes it, and the loop exits without fighting either.
    const live = await deps.db.query.promptRuns.findFirst({ where: eq(promptRuns.id, runId) }).catch(() => null);
    if (!live || live.done) return;

    let state;
    try {
      state = await guest.promptStatus(runId, from);
      unreachableSince = null;
    } catch (e) {
      if (e instanceof GuestError && e.status === 0) {
        unreachableSince ??= Date.now();
        if (Date.now() - unreachableSince < PROMPT_UNREACHABLE_GRACE_MS) {
          await Bun.sleep(PROMPT_POLL_MS);
          continue;
        }
        // The machine is gone; record the failure and let the ori settle back to idle.
        await finishRun(deps, oriId, runId, { failed: true, error: (e as Error).message });
        return;
      }
      // A non-transport guest error is a hard failure of the run itself.
      await finishRun(deps, oriId, runId, { failed: true, error: (e as Error).message });
      return;
    }

    if (!runningEmitted && state.status === "running") {
      runningEmitted = true;
      await emitOriEvent(deps.db, oriId, "prompt", {
        id: runId,
        taskId: runId,
        data: { promptId: runId, status: "running", provider: state.provider },
      });
      await deps.db.update(promptRuns).set({ status: "running" }).where(eq(promptRuns.id, runId)).catch(() => {});
    }

    for (const line of state.lines ?? []) {
      await emitOriEvent(deps.db, oriId, "response", {
        id: runId,
        taskId: runId,
        data: { content: line.text + "\n", isStreaming: !state.done, stream: line.stream },
      }).catch(() => {});
    }
    from += (state.lines ?? []).length;

    if (state.done) {
      await finishRun(deps, oriId, runId, { failed: state.status === "failed", error: state.error });
      return;
    }
    await Bun.sleep(PROMPT_POLL_MS);
  }
}

/** Emit the terminal prompt event, mark the run done, and set the ori back to idle. */
async function finishRun(
  deps: AppDeps,
  oriId: string,
  runId: string,
  opts: { failed: boolean; error: string | null },
): Promise<void> {
  const status = opts.failed ? "failed" : "finished";
  await deps.db
    .update(promptRuns)
    .set({ status, done: true })
    .where(and(eq(promptRuns.id, runId), eq(promptRuns.done, false)))
    .catch(() => {});
  // Only settle to idle if the ori is still in a prompt-derived state; a stop may have
  // moved it to archiving/archived and that must win.
  await deps.db
    .update(oris)
    .set({ state: "idle", updatedAt: new Date() })
    .where(and(eq(oris.id, oriId), eq(oris.state, "running")))
    .catch(() => {});
  await emitOriEvent(deps.db, oriId, "prompt", {
    id: runId,
    taskId: runId,
    data: { promptId: runId, status, ...(opts.error ? { error: opts.error } : {}) },
  }).catch(() => {});
}
