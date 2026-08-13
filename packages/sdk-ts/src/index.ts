/**
 * The TypeScript SDK.
 *
 * The CLIENT is generated: `schema.d.ts` comes straight out of
 * `openapi-typescript openapi/ori-v1.yaml` (regenerate with `make sdk`) and `createOriClient`
 * is the handful of lines that bind a typed fetch to it. That is deliberate — the premise of
 * this project is that the OpenAPI document is faithful enough to generate a client from, and
 * hand-writing request code would hide exactly the gaps we want exposed.
 *
 * Everything below `createOriClient` is hand-written CONVENIENCE over that generated client:
 * poll loops and two-call sequences, no request shapes of their own. If one of them starts
 * encoding knowledge the spec should carry, the spec is what is wrong.
 */
import createClient, { type Client } from "openapi-fetch";
import type { paths, components } from "./schema";

export type { paths, components };

export interface OriClientOptions {
  /** e.g. http://localhost:8787 — the server root, WITHOUT /api/ori/v1. */
  baseUrl: string;
  apiKey: string;
}

/**
 * A typed client. Paths, params, request bodies and response shapes all come from the spec, so
 * a path or field this server does not implement is a compile error rather than a 404 at
 * runtime.
 */
export function createOriClient(opts: OriClientOptions) {
  return createClient<paths>({
    baseUrl: `${opts.baseUrl.replace(/\/+$/, "")}/api/ori/v1`,
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
}

export type OriClient = Client<paths>;

/* ------------------------------------------------------------------------- *
 * Waiters and helpers — hand-written on top of the generated client.
 *
 * These are conveniences over the generated client (waitUntilReady, execCommand, …) and are
 * deliberately thin: polling loops and small wrappers, never business logic. They exist
 * because a typed client is not a workflow — callers were hand-rolling the same poll loop
 * in every integration.
 * ------------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface WaitOptions {
  /** Total time to wait before throwing. Default 180s. */
  timeoutMs?: number;
  /** Delay between polls. Default 1500ms. */
  pollMs?: number;
}

function deadline(opts: WaitOptions, fallback: number): { until: number; pollMs: number } {
  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? fallback;
  return { until: Date.now() + timeoutMs, pollMs };
}

/**
 * Poll GET /oris/{oriId} until the ori is ready (or idle/running — both are usable).
 * Throws when the ori enters `error` or the timeout elapses.
 */
export async function waitUntilReady(client: OriClient, oriId: string, opts: WaitOptions = {}): Promise<string> {
  const { until, pollMs } = deadline(opts, 180_000);
  let last = "";
  while (Date.now() < until) {
    const { data, error } = await client.GET("/oris/{oriId}", { params: { path: { oriId } } });
    if (error) throw new Error(`GET /oris/${oriId}: ${JSON.stringify(error)}`);
    const state = data?.ori?.state;
    if (state === "ready" || state === "idle" || state === "running") return state;
    if (state === "error") throw new Error(`ori ${oriId} entered error state`);
    last = state ?? last;
    await sleep(pollMs);
  }
  throw new Error(`ori ${oriId} not ready within ${opts.timeoutMs ?? 180_000}ms (last state ${last})`);
}

/** Poll until the ori reports `idle` (no agent work queued). */
export async function waitUntilIdle(client: OriClient, oriId: string, opts: WaitOptions = {}): Promise<void> {
  const { until, pollMs } = deadline(opts, 120_000);
  while (Date.now() < until) {
    const { data, error } = await client.GET("/oris/{oriId}", { params: { path: { oriId } } });
    if (error) throw new Error(`GET /oris/${oriId}: ${JSON.stringify(error)}`);
    const state = data?.ori?.state;
    if (state === "idle" || state === "ready") return;
    if (state === "error") throw new Error(`ori ${oriId} entered error state`);
    await sleep(pollMs);
  }
  throw new Error(`ori ${oriId} never became idle within ${opts.timeoutMs ?? 120_000}ms`);
}

/** Poll POST /oris/{oriId}/desktop until the streaming URL is provisioned. */
export async function waitForDesktop(
  client: OriClient,
  oriId: string,
  opts: WaitOptions & { publicAccess?: boolean } = {},
): Promise<string> {
  const { until, pollMs } = deadline(opts, 120_000);
  while (Date.now() < until) {
    const { data, error } = await client.POST("/oris/{oriId}/desktop", {
      params: { path: { oriId } },
      body: opts.publicAccess ? { publicAccess: true } : ({} as never),
    });
    if (error) throw new Error(`POST /oris/${oriId}/desktop: ${JSON.stringify(error)}`);
    if (data?.provisioning !== true && data?.desktopUrl) return data.desktopUrl;
    await sleep(pollMs);
  }
  throw new Error(`desktop for ori ${oriId} not ready within ${opts.timeoutMs ?? 120_000}ms`);
}

/** Execute one bounded command in the ori's work directory. */
export async function execCommand(
  client: OriClient,
  oriId: string,
  command: string,
  opts: { cwd?: string; timeoutSeconds?: number } = {},
) {
  const { data, error } = await client.POST("/oris/{oriId}/commands", {
    params: { path: { oriId } },
    body: { command, cwd: opts.cwd, timeoutSeconds: opts.timeoutSeconds ?? 30 },
  });
  if (error) throw new Error(`POST /oris/${oriId}/commands: ${JSON.stringify(error)}`);
  return data;
}

/** Read a text file from the ori's work dir. */
export async function readText(client: OriClient, oriId: string, path: string) {
  const { data, error } = await client.GET("/oris/{oriId}/files", {
    params: { path: { oriId }, query: { path, encoding: "utf8" } },
  });
  if (error) throw new Error(`GET /oris/${oriId}/files: ${JSON.stringify(error)}`);
  return data;
}

/** Write a text file in the ori's work dir. */
export async function writeText(client: OriClient, oriId: string, path: string, content: string) {
  const { data, error } = await client.PUT("/oris/{oriId}/files", {
    params: { path: { oriId } },
    body: { path, content, encoding: "utf8" },
  });
  if (error) throw new Error(`PUT /oris/${oriId}/files: ${JSON.stringify(error)}`);
  return data;
}

/**
 * Stop, wait for archived, then delete — the full teardown. Deleting destroys the ori's
 * snapshot data, so this is only for when you are truly done with it.
 *
 * DELETE /oris/{oriId} is a documented divergence (self-hosted delete; the spec has no
 * delete), so it is not on the generated client — pass the same baseUrl/apiKey you gave
 * createOriClient and this issues the raw call. They are required rather than defaulted:
 * guessing localhost here would delete on the wrong control plane, silently.
 */
export async function stopAndRemove(
  client: OriClient,
  oriId: string,
  opts: WaitOptions & { apiUrl: string; apiKey: string },
) {
  const { until, pollMs } = deadline(opts, 120_000);
  const stopped = await client.POST("/oris/{oriId}/stop", { params: { path: { oriId } }, body: { force: false } });
  if (stopped.error) throw new Error(`POST /oris/${oriId}/stop: ${JSON.stringify(stopped.error)}`);
  while (Date.now() < until) {
    const { data, error } = await client.GET("/oris/{oriId}", { params: { path: { oriId } } });
    if (error) throw new Error(`GET /oris/${oriId}: ${JSON.stringify(error)}`);
    if (data?.ori?.state === "archived") break;
    await sleep(pollMs);
  }
  const res = await fetch(`${opts.apiUrl.replace(/\/+$/, "")}/api/ori/v1/oris/${oriId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
  if (!res.ok) throw new Error(`DELETE /oris/${oriId}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Poll GET /oris/{oriId}/prompts/{promptId} until the run finishes. Returns the final run.
 */
export async function waitForPrompt(
  client: OriClient,
  oriId: string,
  promptId: string,
  opts: WaitOptions = {},
) {
  const { until, pollMs } = deadline(opts, 600_000);
  for (;;) {
    const { data, error } = await client.GET("/oris/{oriId}/prompts/{promptId}", {
      params: { path: { oriId, promptId } },
    });
    if (error) throw new Error(`GET /oris/${oriId}/prompts/${promptId}: ${JSON.stringify(error)}`);
    const run = data?.promptRun;
    if (run?.done) return run;
    if (Date.now() > until) throw new Error(`prompt ${promptId} not done within ${opts.timeoutMs ?? 600_000}ms`);
    await sleep(pollMs);
  }
}

/**
 * Queue a prompt and stream its response events as they arrive, ending when the run
 * finishes. Yields `response` events (type "response") with taskId = promptId.
 */
export async function* streamPrompt(
  client: OriClient,
  oriId: string,
  req: { provider: "codex" | "claude-code" | "claude"; model?: string | null; reasoningEffort?: string | null; prompt: string },
  opts: WaitOptions = {},
): AsyncGenerator<components["schemas"]["OriEvent"]> {
  const queued = await client.POST("/oris/{oriId}/prompt", {
    params: { path: { oriId } },
    body: { provider: req.provider, model: req.model ?? undefined, reasoningEffort: req.reasoningEffort ?? undefined, prompt: req.prompt },
  });
  if (queued.error) throw new Error(`POST /oris/${oriId}/prompt: ${JSON.stringify(queued.error)}`);
  const promptId = queued.data?.promptId;
  if (!promptId) throw new Error("prompt response had no promptId");

  const { until, pollMs } = deadline(opts, 600_000);
  let cursor: string | null = null;
  for (;;) {
    const query: { limit: number; sort: "asc"; type: string; cursor?: string } = { limit: 100, sort: "asc", type: "response" };
    if (cursor) query.cursor = cursor;
    const { data, error } = await client.GET("/oris/{oriId}/events", { params: { path: { oriId }, query } });
    if (error) throw new Error(`GET /oris/${oriId}/events: ${JSON.stringify(error)}`);
    for (const e of data?.events ?? []) {
      if (e.taskId === promptId) yield e;
    }
    cursor = data?.pageInfo?.followCursor ?? cursor;
    const run = await client.GET("/oris/{oriId}/prompts/{promptId}", { params: { path: { oriId, promptId } } });
    if (run.data?.promptRun?.done) return;
    if (Date.now() > until) throw new Error(`prompt ${promptId} not done within ${opts.timeoutMs ?? 600_000}ms`);
    await sleep(pollMs);
  }
}

/**
 * Stream a ori's events with cursor pagination, yielding one event at a time. Stop the
 * iterator (break / AbortSignal) to stop polling.
 */
export async function* streamEvents(
  client: OriClient,
  oriId: string,
  opts: WaitOptions & { types?: string[] } = {},
): AsyncGenerator<components["schemas"]["OriEvent"]> {
  const { until, pollMs } = deadline(opts, 300_000);
  let cursor: string | null = null;
  while (Date.now() < until) {
    const query: { limit: number; sort: "asc"; cursor?: string; type?: string } = { limit: 100, sort: "asc" };
    if (cursor) query.cursor = cursor;
    if (opts.types?.length) query.type = opts.types.join(",");
    const { data, error } = await client.GET("/oris/{oriId}/events", {
      params: { path: { oriId }, query },
    });
    if (error) throw new Error(`GET /oris/${oriId}/events: ${JSON.stringify(error)}`);
    for (const e of data?.events ?? []) yield e;
    cursor = data?.pageInfo?.followCursor ?? cursor;
    if (!data?.pageInfo?.hasMore) await sleep(pollMs);
  }
}
