import type { Hono } from "hono";
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  ACTIVE,
  CreateOriRequestSchema,
  UpdateOriRequestSchema,
  StopRequestSchema,
  ResumeRequestSchema,
  ForkOriRequestSchema,
  CommandRequestSchema,
  FileWriteRequestSchema,
  PromptRequestSchema,
  applyAction,
  oriId,
  promptRunId,
  fail,
  ok,
  paginate,
  validateOriName,
  validateEnvObject,
  validateSubdomain,
  type OriState,
  type ErrorCode,
} from "@ori/contract";
import { oriEnv, oriMetrics, oris, oriEvents, promptRuns } from "../db/schema";
import { BASE_PATH, type AppDeps, type AppEnv } from "../context";
import { MAX_ACTIVE_ORIS, BASE_IMAGE } from "../constants";
import { agentToken, machineToken } from "../tokens";
import { stopOri } from "../lifecycle/stop";
import { resumeOri } from "../lifecycle/resume";
import { forkOri } from "../lifecycle/fork";
import { GuestClient, GuestError, translateGuestError } from "../guest/client";
import { sha256Hex } from "../middleware/auth";
import { checkCreationAllowed, recordStart } from "../rateLimit";
import { oriIp, toOri } from "../serialize";
import type { RequestableMachineType } from "@ori/contract";
import { deleteOri } from "../lifecycle/delete";
import { DESKTOP_TOKEN_TTL_SECONDS, mintDesktopToken } from "../desktop/token";
import { desktopViewerUrl } from "../desktop/proxy";
import { provisionToReady } from "../lifecycle/provision";
import { emitOriEvent } from "../lifecycle/events";
import { pollPromptRun } from "../lifecycle/prompt";

function defaultName(now: Date): string {
  return `Ori ${now.toISOString().slice(0, 16).replace("T", " ")}`;
}

/**
 * A guest 400 on /files can be either a path rejection (the guest's "absolute
 * secret file paths are skipped" wording is the secrets validator leaking and
 * is misleading — on /files a write is refused, not skipped) or a size cap
 * rejection ("content exceeds N bytes"). Rewrite only the path wording.
 */
function filesInvalidMessage(e: unknown): string | undefined {
  if (e instanceof GuestError && /path|absolute|escapes|\.\./i.test(e.message)) {
    return "path must be a relative path inside the work directory";
  }
  return undefined; // carry the guest's message (e.g. the size cap) through
}

/**
 * Ori lifecycle routes: create, list, get, patch, stop, resume, fork.
 * All behind the global auth middleware; ori ownership is enforced on the row.
 */
export function registerOriRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const b = BASE_PATH;
  const now = () => (deps.now ?? (() => new Date()))();

  app.post(`${b}/oris`, async (c) => {
    const userId = c.get("userId")!;

    const raw = await c.req.json().catch(() => null);
    if (raw === null) return c.json(fail(400, "invalid_json"), 400);
    const parsed = CreateOriRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json(fail(400, "invalid_json"), 400);
    const req = parsed.data;

    const envCheck = validateEnvObject(req.env);
    if (!envCheck.ok) return c.json(fail(400, envCheck.code as ErrorCode, envCheck.message), 400);

    // §4 limits: rate limiter first, then the active-ori cap.
    const rate = await checkCreationAllowed(deps.db, userId, now());
    if (!rate.ok) return c.json(fail(429, rate.code), 429);

    const [{ active }] = await deps.db
      .select({ active: sql<number>`count(*)::int` })
      .from(oris)
      .where(and(eq(oris.userId, userId), inArray(oris.state, [...ACTIVE])));
    if (active >= MAX_ACTIVE_ORIS) return c.json(fail(429, "start_limit_reached"), 429);

    const id = oriId();
    const createdAt = now();
    const archiveAfter = req.ttlSeconds ? new Date(createdAt.getTime() + req.ttlSeconds * 1000) : null;
    const mt = machineToken(id);
    const at = agentToken(id);

    await deps.db.insert(oris).values({
      id,
      userId,
      name: defaultName(createdAt),
      state: "provisioning",
      type: req.type,
      noEnv: req.noEnv,
      display: req.display,
      machineTokenHash: sha256Hex(mt),
      agentTokenHash: sha256Hex(at),
      ttlSeconds: req.ttlSeconds,
      archiveAfter,
      createdAt,
      updatedAt: createdAt,
    });

    // Per-box env is stored regardless of noEnv: no-env withholds ACCOUNT secrets (env vars,
    // secret files, credentials), but an explicitly-passed env is not an account secret —
    // Box's docs: "To give one a secret of its own, pass it explicitly with env". applyEnvToOri
    // decides what reaches the machine.
    if (req.env && Object.keys(req.env).length > 0) {
      await deps.db.insert(oriEnv).values(
        Object.entries(req.env).map(([key, value]) => ({ oriId: id, key, value })),
      );
    }
    await emitOriEvent(deps.db, id, "ori.created", { data: { type: req.type, noEnv: req.noEnv, display: req.display } });

    let machineId: string;
    let ip: string;
    try {
      const created = await deps.driver.create({
        oriId: id,
        type: req.type,
        image: BASE_IMAGE,
        machineToken: mt,
        agentToken: at,
      });
      machineId = created.machineId;
      ip = created.ip;
    } catch (e) {
      await deps.db
        .update(oris)
        .set({ state: "error", error: (e as Error).message, updatedAt: now() })
        .where(eq(oris.id, id));
      await emitOriEvent(deps.db, id, "ori.error", { data: { error: (e as Error).message } });
      return c.json(fail(500, "internal_error"), 500);
    }

    await deps.db
      .update(oris)
      .set({ machineId, ip, updatedAt: now() })
      .where(eq(oris.id, id));

    deps.tokens.set(id, { machineToken: mt, agentToken: at });
    await recordStart(deps.db, userId, id, "create", now());

    // Async: once the guest answers /health the ori flips to ready.
    void provisionToReady(deps, id);

    const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, id) });
    // Snapshot semantics: 202 accepts the ori as provisioning; a later GET
    // reflects the live state (ready once the guest answered /health).
    return c.json(
      ok("ori.created", { status: "provisioning", ttlSeconds: req.ttlSeconds, ori: { ...toOri(row!), state: "provisioning" } }),
      202,
    );
  });

  // ---- GET /oris (cursor pagination, newest first) ----

  app.get(`${b}/oris`, async (c) => {
    const userId = c.get("userId")!;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 200);
    const cursor = c.req.query("cursor") ?? null;
    const sort = c.req.query("sort") === "asc" ? "asc" : "desc";
    const stateFilter = c.req.query("state")?.split(",").filter(Boolean) ?? null;

    const conds: SQL[] = [eq(oris.userId, userId)];
    if (stateFilter?.length) conds.push(inArray(oris.state, stateFilter));
    if (cursor) {
      const { at, id } = decodeCursor(cursor);
      // Opaque, base64url-encoded `<createdAtEpochMs>:<id>`.
      const atMs = at.getTime();
      if (sort === "desc") {
        conds.push(sql`(${oris.createdAt} < to_timestamp(${atMs} / 1000.0) or (${oris.createdAt} = to_timestamp(${atMs} / 1000.0) and ${oris.id} < ${id}))`);
      } else {
        conds.push(sql`(${oris.createdAt} > to_timestamp(${atMs} / 1000.0) or (${oris.createdAt} = to_timestamp(${atMs} / 1000.0) and ${oris.id} > ${id}))`);
      }
    }

    const rows = await deps.db.query.oris.findMany({
      where: and(...conds),
      orderBy: sort === "desc" ? desc(oris.createdAt) : asc(oris.createdAt),
      limit: limit + 1,
    });
    const { page, pageInfo } = paginate({
      rows: rows.map((r) => ({ row: r, cursor: encodeCursor(r) })),
      limit,
      cursor,
      encodeCursor: (x) => x.cursor,
    });
    return c.json(
      ok("ori.list", {
        oris: page.map((x) => toOri(x.row)),
        pageInfo: { nextCursor: pageInfo.nextCursor, hasMore: pageInfo.hasMore, limit: pageInfo.limit },
      }),
    );
  });

  // ---- GET /oris/{oriId} ----

  app.get(`${b}/oris/:oriId`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);
    return c.json(ok("ori.info", { ori: toOri(row) }));
  });

  // ---- PATCH /oris/{oriId} ----

  app.patch(`${b}/oris/:oriId`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const raw = await c.req.json().catch(() => null);
    if (raw === null) return c.json(fail(400, "invalid_json"), 400);
    const parsed = UpdateOriRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json(fail(400, "invalid_json"), 400);
    const req = parsed.data;

    const patch: Record<string, unknown> = {};
    if (req.name !== undefined) {
      const check = validateOriName(req.name);
      if (!check.ok) return c.json(fail(400, check.code as ErrorCode, check.message), 400);
      patch.name = req.name;
    }
    if (req.ttlSeconds !== undefined) {
      patch.ttlSeconds = req.ttlSeconds;
      // TTL updates reset the auto-stop clock from now.
      patch.archiveAfter = req.ttlSeconds ? new Date(now().getTime() + req.ttlSeconds * 1000) : null;
    }
    if (req.subdomain !== undefined) {
      const check = validateSubdomain(req.subdomain);
      if (!check.ok) return c.json(fail(400, check.code as ErrorCode, check.message), 400);
      const taken = await deps.db.query.oris.findFirst({
        where: and(eq(oris.subdomain, req.subdomain), ne(oris.id, oriIdParam)),
      });
      if (taken) return c.json(fail(409, "subdomain_taken"), 409);
      patch.subdomain = req.subdomain;
    }
    patch.updatedAt = now();

    await deps.db.update(oris).set(patch).where(eq(oris.id, oriIdParam));
    const updated = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriIdParam) });
    return c.json(ok("ori.info", { ori: toOri(updated!) }));
  });

  // ---- POST /oris/{oriId}/stop ----

  app.post(`${b}/oris/:oriId/stop`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const raw = await c.req.json().catch(() => null);
    let force = false;
    if (raw !== null) {
      const parsed = StopRequestSchema.safeParse(raw);
      if (!parsed.success) return c.json(fail(400, "invalid_json"), 400);
      force = parsed.data.force;
    }

    const outcome = await stopOri(deps, oriIdParam, force);
    if (!outcome.ok) return c.json(fail(outcome.status as 400 | 404 | 500, outcome.code as ErrorCode, outcome.message), outcome.status);

    const stopped = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriIdParam) });
    return c.json(
      ok("ori.stopping", { id: oriIdParam, status: "archiving", ori: { ...toOri(stopped!), state: "archiving" } }),
      202,
    );
  });

  // ---- POST /oris/{oriId}/resume ----

  app.post(`${b}/oris/:oriId/resume`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const raw = await c.req.json().catch(() => null);
    let req: { type?: RequestableMachineType; noEnv?: boolean } = {};
    if (raw !== null) {
      const parsed = ResumeRequestSchema.safeParse(raw);
      if (!parsed.success) return c.json(fail(400, "invalid_json"), 400);
      req = parsed.data;
    }

    const outcome = await resumeOri(deps, oriIdParam, req, now());
    if (!outcome.ok) return c.json(fail(outcome.status as 400 | 404 | 409 | 500, outcome.code as ErrorCode, outcome.message), outcome.status);

    const resumed = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriIdParam) });
    return c.json(
      ok("ori.resuming", { id: oriIdParam, status: "resuming", ori: { ...toOri(resumed!), state: "provisioning" } }),
      202,
    );
  });

  // ---- DELETE /oris/{oriId} ----
  /**
   * Delete a ori and its snapshot data. Not in the published spec — ori has no delete at
   * all, which leaves a self-hosted operator no way to reclaim object storage. See
   * docs/DIVERGENCES.md.
   */
  app.delete(`${b}/oris/:oriId`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const outcome = await deleteOri(deps, oriIdParam);
    if (!outcome.ok) return c.json(fail(outcome.status, outcome.code as ErrorCode), outcome.status);

    return c.json(
      ok("ori.deleted", {
        id: oriIdParam,
        snapshotsDeleted: outcome.snapshotsDeleted,
        objectsDeleted: outcome.objectsDeleted,
        // -1 means the object store could not even be listed; anything > 0 is a real leak.
        objectsFailed: outcome.objectsFailed,
      }),
    );
  });

  // ---- POST /oris/{oriId}/desktop ----

  /**
   * Mint a desktop URL. Starts the lazy desktop inside the ori, signs a short-lived token
   * bound to THIS ori, and returns a URL the control plane's proxy will accept.
   *
   * `publicAccess: true` is ori's documented escape hatch (--public) for a link you mean to
   * share; it still carries a token, it just marks the row so the proxy does not additionally
   * require the caller's API key. Default is false.
   */
  /**
   * POST /oris/{oriId}/prompt — queue a natural-language work item for the agent inside
   * the ori (codex / claude-code, whatever the operator installed and logged in inside the
   * box). One active run per ori. The machine flips to `running`; progress streams into
   * GET /oris/{oriId}/events as `response` events with taskId = run id.
   */
  app.post(`${b}/oris/:oriId/prompt`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const gate = applyAction("prompt", row.state as OriState);
    if (!gate.ok) return c.json(fail(409, gate.code as ErrorCode), 409);

    const raw = await c.req.json().catch(() => null);
    if (raw === null) return c.json(fail(400, "invalid_json"), 400);
    const parsed = PromptRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json(fail(400, "invalid_json"), 400);
    const req = parsed.data;
    // The schema's min(1) counts whitespace; the docs' prompt_required means a non-empty
    // prompt ("no non-empty prompt"), so trim-check here rather than weakening the schema.
    if (!req.prompt.trim()) return c.json(fail(400, "prompt_required"), 400);

    // One agent run at a time; a second prompt while one is live is refused, not queued.
    const active = await deps.db.query.promptRuns.findFirst({
      where: and(eq(promptRuns.oriId, oriIdParam), eq(promptRuns.done, false)),
    });
    if (active) {
      return c.json(fail(409, "ori_not_promptable", "an agent run is already active in this ori"), 409);
    }

    const tokens = deps.tokens.get(oriIdParam);
    if (!row.ip || !tokens) return c.json(fail(400, "machine_not_running"), 400);

    const runId = promptRunId();
    const now = new Date();
    await deps.db.insert(promptRuns).values({
      id: runId,
      promptId: runId,
      oriId: oriIdParam,
      status: "queued",
      provider: req.provider,
      model: req.model ?? null,
      reasoningEffort: req.reasoningEffort ?? null,
      prompt: req.prompt,
      createdAt: now,
      done: false,
    });
    await deps.db.update(oris).set({ state: "running", updatedAt: now }).where(eq(oris.id, oriIdParam));
    await emitOriEvent(deps.db, oriIdParam, "prompt", {
      id: runId,
      taskId: runId,
      data: {
        promptId: runId,
        status: "queued",
        provider: req.provider,
        model: req.model ?? null,
        reasoningEffort: req.reasoningEffort ?? null,
        prompt: req.prompt,
      },
    });

    const guest = GuestClient.forIp(row.ip, tokens.agentToken);
    try {
      await guest.prompt({
        promptId: runId,
        provider: req.provider,
        model: req.model ?? null,
        reasoningEffort: req.reasoningEffort ?? null,
        prompt: req.prompt,
      });
    } catch (e) {
      // The guest refused (provider not installed) or was unreachable: put the ori back
      // to idle and record the failure on the run rather than leaving it stuck running.
      await deps.db.update(oris).set({ state: "idle", updatedAt: new Date() }).where(eq(oris.id, oriIdParam));
      await deps.db
        .update(promptRuns)
        .set({ status: "failed", done: true })
        .where(eq(promptRuns.id, runId));
      const message = e instanceof GuestError ? e.message : (e as Error).message;
      await emitOriEvent(deps.db, oriIdParam, "prompt", { id: runId, taskId: runId, data: { promptId: runId, status: "failed", error: message } });
      if (e instanceof GuestError && e.status === 409) {
        return c.json(fail(409, "provider_not_configured", message), 409);
      }
      return c.json(translateGuestError(e, "prompt"), 502);
    }

    // Drain the run in the background; the route answers once the work is queued.
    void pollPromptRun(deps, oriIdParam, runId);

    const run = await deps.db.query.promptRuns.findFirst({ where: eq(promptRuns.id, runId) });
    return c.json(
      ok("prompt.queued", {
        id: runId,
        promptId: runId,
        status: "queued",
        provider: req.provider,
        model: req.model ?? null,
        reasoningEffort: req.reasoningEffort ?? null,
        promptRun: {
          id: runId,
          promptId: runId,
          boxId: oriIdParam,
          status: run?.status ?? "queued",
          done: false,
          createdAt: now.toISOString(),
          model: req.model ?? null,
          reasoningEffort: req.reasoningEffort ?? null,
        },
      }),
      202,
    );
  });

  /** GET /oris/{oriId}/prompts/{promptId} — first-class run status. */
  app.get(`${b}/oris/:oriId/prompts/:promptId`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const promptId = c.req.param("promptId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);
    const run = await deps.db.query.promptRuns.findFirst({
      where: and(eq(promptRuns.id, promptId), eq(promptRuns.oriId, oriIdParam)),
    });
    if (!run) return c.json(fail(404, "not_found"), 404);
    return c.json(
      ok("prompt_run.info", {
        id: run.id,
        promptRun: {
          id: run.id,
          promptId: run.promptId,
          boxId: oriIdParam,
          status: run.status,
          done: run.done,
          createdAt: run.createdAt.toISOString(),
          model: run.model,
          reasoningEffort: run.reasoningEffort,
        },
      }),
    );
  });

  /** POST /oris/{oriId}/interrupt — stop the agent currently working in the ori. */
  app.post(`${b}/oris/:oriId/interrupt`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const gate = applyAction("interrupt", row.state as OriState);
    if (!gate.ok) return c.json(fail(409, gate.code as ErrorCode), 409);

    const tokens = deps.tokens.get(oriIdParam);
    if (!row.ip || !tokens) return c.json(fail(400, "machine_not_running"), 400);

    const guest = GuestClient.forIp(row.ip, tokens.agentToken);
    try {
      await guest.interrupt();
    } catch (e) {
      return c.json(translateGuestError(e, "interrupt"), 502);
    }

    const now = new Date();
    // Whichever run was live is the one that was interrupted; carrying its id on the event
    // keeps every `prompt` event addressable by taskId, like the queued/running/finished ones.
    const interrupted = await deps.db
      .update(promptRuns)
      .set({ status: "interrupted", done: true })
      .where(and(eq(promptRuns.oriId, oriIdParam), eq(promptRuns.done, false)))
      .returning({ id: promptRuns.id });
    await deps.db.update(oris).set({ state: "idle", updatedAt: now }).where(eq(oris.id, oriIdParam));
    for (const run of interrupted) {
      await emitOriEvent(deps.db, oriIdParam, "prompt", {
        id: run.id,
        taskId: run.id,
        data: { promptId: run.id, status: "interrupted" },
      });
    }
    if (interrupted.length === 0) {
      await emitOriEvent(deps.db, oriIdParam, "prompt", { data: { status: "interrupted" } });
    }

    return c.json(ok("ori.interrupted", { id: oriIdParam, status: "idle" }));
  });

  app.post(`${b}/oris/:oriId/desktop`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const gate = applyAction("desktop", row.state as OriState);
    if (!gate.ok) return c.json(fail(400, gate.code as ErrorCode), 400);

    // The units exist inside every ori and would start on demand; refusing here is the
    // point of the flag. Nothing is broken — the caller did not ask for a display.
    if (!row.display) return c.json(fail(409, "display_disabled"), 409);

    const tokens = deps.tokens.get(oriIdParam);
    if (!row.ip || !tokens) return c.json(fail(400, "machine_not_running"), 400);

    const raw = (await c.req.json().catch(() => ({}))) as { publicAccess?: unknown };
    const publicAccess = raw?.publicAccess === true;

    let ready = false;
    try {
      const started = await GuestClient.forIp(row.ip, tokens.agentToken).desktopStart();
      ready = started.ready === true;
    } catch (e) {
      return c.json(translateGuestError(e, "desktop"), 502);
    }

    const token = mintDesktopToken(oriIdParam);
    const expiresAt = new Date(Date.now() + DESKTOP_TOKEN_TTL_SECONDS * 1000);
    await deps.db
      .update(oris)
      .set({ desktopAvailable: true, desktopToken: token, desktopExpiresAt: expiresAt, updatedAt: new Date() })
      .where(eq(oris.id, oriIdParam));

    const base = process.env.ORI_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
    // Built in desktop/proxy.ts, beside the routing it has to match — see websocketPath().
    const desktopUrl = desktopViewerUrl(base, oriIdParam, token);

    return c.json(
      ok("desktop.url", {
        success: true,
        desktopUrl,
        ip: oriIp(row.ip),
        mode: "vnc",
        // `provisioning: true` means the units are up but noVNC was not answering yet — the
        // caller should retry rather than hand a user a black screen.
        provisioning: !ready,
        publicAccess,
        expiresAt: expiresAt.toISOString(),
      }),
    );
  });

  // ---- POST /oris/{oriId}/sshkey ----

  /**
   * Authorise a public key and tell the caller how to connect. The CLI's `ori ssh` is a
   * thin wrapper over this plus the system ssh: keep a key locally, push the public half,
   * exec ssh.
   */
  app.post(`${b}/oris/:oriId/sshkey`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const gate = applyAction("sshkey", row.state as OriState);
    if (!gate.ok) return c.json(fail(400, gate.code as ErrorCode), 400);

    const raw = await c.req.json().catch(() => null);
    if (raw === null || typeof raw !== "object") return c.json(fail(400, "invalid_json"), 400);
    const key = (raw as { key?: unknown }).key;
    if (typeof key !== "string" || key.trim().length === 0) {
      return c.json(fail(400, "invalid_json", "key is required"), 400);
    }

    const tokens = deps.tokens.get(oriIdParam);
    if (!row.ip || !tokens) return c.json(fail(400, "machine_not_running"), 400);

    try {
      const guest = GuestClient.forIp(row.ip, tokens.agentToken);
      const result = await guest.sshkey(key);

      // How to reach sshd. On a real host the ori has its own routable IPv4 and port 22 is
      // the answer; under the docker driver there is no routable IP, so the driver reports
      // the published loopback address instead. sshHost/sshPort are a declared divergence —
      // the spec has only machineIp/sshUser, which cannot express "loopback plus a port".
      let sshHost: string | null = null;
      let sshPort: number | null = null;
      const driverWithSsh = deps.driver as { sshAddress?: (m: string) => Promise<{ host: string; port: number } | null> };
      if (row.machineId && typeof driverWithSsh.sshAddress === "function") {
        const addr = await driverWithSsh.sshAddress(row.machineId);
        if (addr) {
          sshHost = addr.host;
          sshPort = addr.port;
        }
      }

      return c.json(
        ok("sshkey.authorized", {
          success: true,
          machineIp: oriIp(row.ip),
          sshUser: result.sshUser,
          sshHost,
          sshPort,
          /*
           * Which machine this ori is currently running on.
           *
           * A resume or a fork builds a NEW machine, and a machine generates its own SSH host
           * keys — so the same ori id legitimately presents a different host key over its life.
           * A client that pins host keys by ori id therefore greets every resume with
           * "REMOTE HOST IDENTIFICATION HAS CHANGED", which is alarming, wrong, and trains
           * people to ignore the one warning that matters.
           *
           * Pinning per machine instead makes the rotation invisible and keeps the warning
           * meaningful: a changed key for the SAME machine is still a real event.
           */
          machineId: row.machineId,
          alreadyPresent: result.alreadyPresent,
        }),
      );
    } catch (e) {
      return c.json(translateGuestError(e, "sshkey"), (e as { status?: number }).status === 400 ? 400 : 502);
    }
  });

  // ---- POST /oris/{oriId}/fork ----

  app.post(`${b}/oris/:oriId/fork`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const raw = await c.req.json().catch(() => null);
    let req: { env?: Record<string, string>; noEnv?: boolean; type?: RequestableMachineType } = {};
    if (raw !== null) {
      const parsed = ForkOriRequestSchema.safeParse(raw);
      if (!parsed.success) return c.json(fail(400, "invalid_json"), 400);
      req = parsed.data;
    }
    if (req.env !== undefined) {
      const envCheck = validateEnvObject(req.env);
      if (!envCheck.ok) return c.json(fail(400, envCheck.code as ErrorCode, envCheck.message), 400);
    }

    // A fork counts as one machine start.
    const rate = await checkCreationAllowed(deps.db, userId, now());
    if (!rate.ok) return c.json(fail(429, rate.code), 429);

    const outcome = await forkOri(deps, oriIdParam, req, now());
    if (!outcome.ok) return c.json(fail(outcome.status as 400 | 404 | 409 | 500, outcome.code as ErrorCode, outcome.message), outcome.status);

    const forked = await deps.db.query.oris.findFirst({ where: eq(oris.id, outcome.oriId) });
    return c.json(
      ok("ori.forking", { id: outcome.oriId, status: "forking", ori: { ...toOri(forked!), state: "provisioning" } }),
      202,
    );
  });

  // ---- POST /oris/{oriId}/commands ----

  app.post(`${b}/oris/:oriId/commands`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    // State gate from the contract table: commands are only legal in the
    // runnable window. Same applyAction the rest of the lifecycle uses.
    const gate = applyAction("command", row.state as OriState);
    if (!gate.ok) return c.json(fail(400, "machine_not_running"), 400);

    const raw = await c.req.json().catch(() => null);
    if (raw === null) return c.json(fail(400, "invalid_json"), 400);
    const parsed = CommandRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json(fail(400, "invalid_json"), 400);
    const req = parsed.data;

    const tokens = deps.tokens.get(oriIdParam);
    if (!tokens || !row.ip) return c.json(fail(502, "gateway_error"), 502);

    try {
      const result = await GuestClient.forIp(row.ip, tokens.agentToken).exec({
        command: req.command,
        cwd: req.cwd,
        timeoutSeconds: req.timeoutSeconds,
      });
      return c.json(result);
    } catch (e) {
      const t = translateGuestError(e);
      return c.json(fail(t.status, t.code, t.message), t.status);
    }
  });

  // ---- GET /oris/{oriId}/files ----

  app.get(`${b}/oris/:oriId/files`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const gate = applyAction("files", row.state as OriState);
    if (!gate.ok) return c.json(fail(400, "machine_not_running"), 400);

    const path = c.req.query("path");
    if (path === undefined || path === "") return c.json(fail(400, "invalid_json", "path is required"), 400);
    const encoding = c.req.query("encoding") ?? "utf8";

    const tokens = deps.tokens.get(oriIdParam);
    if (!tokens || !row.ip) return c.json(fail(502, "gateway_error"), 502);

    try {
      const result = await GuestClient.forIp(row.ip, tokens.agentToken).readFile(path, encoding);
      return c.json(ok("file.read", { success: true, path: result.path, encoding: result.encoding, size: result.size, content: result.content }));
    } catch (e) {
      const t = translateGuestError(e, filesInvalidMessage(e));
      return c.json(fail(t.status, t.code, t.message), t.status);
    }
  });

  // ---- PUT /oris/{oriId}/files ----

  app.put(`${b}/oris/:oriId/files`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const gate = applyAction("files", row.state as OriState);
    if (!gate.ok) return c.json(fail(400, "machine_not_running"), 400);

    const raw = await c.req.json().catch(() => null);
    if (raw === null) return c.json(fail(400, "invalid_json"), 400);
    const parsed = FileWriteRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json(fail(400, "invalid_json"), 400);
    const req = parsed.data;

    const tokens = deps.tokens.get(oriIdParam);
    if (!tokens || !row.ip) return c.json(fail(502, "gateway_error"), 502);

    try {
      const result = await GuestClient.forIp(row.ip, tokens.agentToken).writeFile({
        path: req.path,
        content: req.content,
        encoding: req.encoding,
      });
      return c.json(ok("file.written", { success: true, path: result.path, encoding: result.encoding, size: result.size }));
    } catch (e) {
      const t = translateGuestError(e, filesInvalidMessage(e));
      return c.json(fail(t.status, t.code, t.message), t.status);
    }
  });

  // ---- GET /oris/{oriId}/artifacts ----

  app.get(`${b}/oris/:oriId/artifacts`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const gate = applyAction("files", row.state as OriState);
    if (!gate.ok) return c.json(fail(400, "machine_not_running"), 400);

    const path = c.req.query("path");
    if (path === undefined || path === "") return c.json(fail(400, "invalid_json", "path is required"), 400);

    const tokens = deps.tokens.get(oriIdParam);
    if (!tokens || !row.ip) return c.json(fail(502, "gateway_error"), 502);

    try {
      const res = await GuestClient.forIp(row.ip, tokens.agentToken).artifact(path);
      // Relay the guest's streamed body without buffering it.
      return new Response(res.body, { status: 200, headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" } });
    } catch (e) {
      const t = translateGuestError(e, filesInvalidMessage(e));
      return c.json(fail(t.status, t.code, t.message), t.status);
    }
  });

  // ---- GET /oris/{oriId}/events (cursor pagination over seq) ----

  /**
   * GET /oris/{oriId}/metrics — the recent resource series for the sparklines.
   *
   * New API surface, declared in docs/DIVERGENCES.md: the v1 spec documents no metrics
   * endpoint, though its dashboard clearly has one (its table carries a CPU/RAM/Disk/IO column).
   * Read-only, bounded by MAX_METRIC_SAMPLES, and empty rather than fabricated when a driver
   * cannot sample — the dashboard renders a dash for that, not a flat line at zero.
   */
  app.get(`${b}/oris/:oriId/metrics`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({ where: eq(oris.id, oriIdParam) });
    // 404 for someone else's sandbox, never 403: a 403 confirms the id exists.
    if (!row || row.userId !== userId) return c.json(fail(404, "not_found"), 404);

    // A plain select, not db.query.oriMetrics.findMany. The relational query returned an empty
    // array for an id that demonstrably had rows -- reproduced against the live database. Not
    // worth diagnosing drizzle's relational layer for a single-table read with no joins: this is
    // the simpler construct and it is the one that works.
    const rows = await deps.db
      .select()
      .from(oriMetrics)
      .where(eq(oriMetrics.oriId, oriIdParam))
      .orderBy(asc(oriMetrics.at))
      .limit(1000);

    return c.json(
      ok("ori.metrics", {
        oriId: oriIdParam,
        samples: rows.map((r) => ({
          at: r.at.toISOString(),
          cpuPercent: r.cpuPercent,
          memBytes: r.memBytes,
          memLimitBytes: r.memLimitBytes,
          // Percentages computed here so every client agrees on them, rather than each one
          // re-deriving and one of them getting the divide-by-zero case wrong.
          memPercent: r.memLimitBytes > 0 ? (r.memBytes / r.memLimitBytes) * 100 : 0,
          diskUsedBytes: r.diskUsedBytes,
          diskTotalBytes: r.diskTotalBytes,
          diskPercent: r.diskTotalBytes > 0 ? (r.diskUsedBytes / r.diskTotalBytes) * 100 : 0,
          ioPercent: r.ioPercent,
          blockIoBytes: r.blockIoBytes,
          netIoBytes: r.netIoBytes,
        })),
        /** Only from the newest sample: a process list is a snapshot, not a series. */
        topProcesses: rows.length > 0 ? (rows[rows.length - 1]!.topProcesses ?? []) : [],
      }),
    );
  });

  app.get(`${b}/oris/:oriId/events`, async (c) => {
    const userId = c.get("userId")!;
    const oriIdParam = c.req.param("oriId");
    const row = await deps.db.query.oris.findFirst({
      where: and(eq(oris.id, oriIdParam), eq(oris.userId, userId)),
    });
    if (!row) return c.json(fail(404, "not_found"), 404);

    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 200);
    const cursor = c.req.query("cursor") ?? null;
    const sort = c.req.query("sort") === "asc" ? "asc" : "desc";
    const typeFilter = c.req.query("type")?.split(",").filter(Boolean) ?? null;

    const conds: SQL[] = [eq(oriEvents.oriId, oriIdParam)];
    if (typeFilter?.length) conds.push(inArray(oriEvents.type, typeFilter));
    if (cursor) {
      const seq = decodeSeqCursor(cursor);
      conds.push(sort === "asc" ? sql`${oriEvents.seq} > ${seq}` : sql`${oriEvents.seq} < ${seq}`);
    }

    const rows = await deps.db.query.oriEvents.findMany({
      where: and(...conds),
      orderBy: sort === "asc" ? asc(oriEvents.seq) : desc(oriEvents.seq),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const nextCursor = hasMore ? encodeSeqCursor(page[page.length - 1].seq) : null;
    return c.json(
      ok("events.list", {
        id: oriIdParam,
        events: page.map((x) => ({
          id: x.id ?? undefined,
          type: x.type,
          timestamp: x.timestamp,
          taskId: x.taskId ?? null,
          data: x.data,
        })),
        // followCursor is nextCursor's long-poll twin: nextCursor is null on the last page
        // (the API-wide invariant "null exactly when hasMore is false"), but a client
        // streaming the ori needs a cursor positioned after the newest event it has seen so
        // the next call returns only what arrived since. Without it every follower has to
        // re-derive the cursor encoding itself.
        pageInfo: { nextCursor, hasMore, limit, followCursor: page.length > 0 ? encodeSeqCursor(page[page.length - 1].seq) : cursor },
      }),
    );
  });
}

/** Base64url-encode `<createdAtEpochMs>:<id>` so cursors stay opaque and sortable. */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.getTime()}:${row.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [ms, id] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
  return { at: new Date(Number(ms)), id };
}

/** Base64url-encode the bigserial `seq` used to paginate the event stream. */
function encodeSeqCursor(seq: number): string {
  return Buffer.from(String(seq)).toString("base64url");
}

function decodeSeqCursor(cursor: string): number {
  return Number(Buffer.from(cursor, "base64url").toString("utf8"));
}
