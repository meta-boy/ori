import { Hono } from "hono";
import { statfs } from "node:fs/promises";
import { sha256Hex, timingSafeEqualHex } from "@ori/contract";
import { runCommand, parseExecRequest, DEFAULT_WORK_DIR } from "./exec";
import { readFileInWorkDir, writeFileInWorkDir, openArtifact, FileError, normalizeEncoding } from "./file";
import { applyEnv, DEFAULT_ENV_FILE } from "./env";
import { parseClockRequest, runClock, type ClockRunner } from "./clock";
import { parseSnapshotRequest, runSnapshot, redactSecrets } from "./snapshot";
import { runRestore } from "./restore";
import { authorizeKey, SshKeyError } from "./sshkey";
import { startDesktop, stopDesktop } from "./desktop";
import {
  PromptRegistry,
  PromptSession,
  ProviderNotConfigured,
  providerCommand,
  providerInstalled,
  runPromptSession,
} from "./prompt";
import { hostEnvFromProcess, hostHide, hostList, hostPort, hostUrl } from "./host";

export interface GuestAgentOptions {
  oriId: string;
  agentToken: string;
  /** Injectable clock (epoch ms) so tests control uptimeSeconds. */
  now?: () => number;
  /**
   * Injectable `date -s` runner for POST /clock (a snapshot-resumed VM wakes with its
   * clock frozen at suspend time). Tests fake it so no real system clock is touched.
   */
  clockRunner?: ClockRunner;
  /** Injectable disk usage provider; defaults to statfs on "/". */
  diskUsedBytes?: () => Promise<number>;
  /** Hook for tests to observe emitted request log lines. */
  onLog?: (line: Record<string, unknown>) => void;
  /**
   * Work directory the guest operates in (cwd default, file root, …).
   * Defaults to ORI_WORK_DIR, then /home/user. Configurable so the guest runs
   * hermetically in tests and against a real path under the Docker/Incus
   * drivers.
   */
  workDir?: string;
  /**
   * Path of the ori env file. Defaults to ORI_ENV_FILE, then /etc/ori.env.
   * Configurable so tests can point it at a writable temp path.
   */
  envFile?: string;
  /**
   * Path of the ori's Docker volumes dir. Defaults to /var/lib/docker/volumes.
   * Snapshots back it up when present and skip it silently when absent (finding
   * #10); configurable so tests can seed or omit it hermetically.
   */
  volumesDir?: string;
  /**
   * Base-image /etc manifest the snapshot sysdiff diffs against. Defaults to
   * /opt/ori/ori-image/etc-manifest.json (written at image build time).
   * Configurable for tests.
   */
  etcBaselinePath?: string;
  /** Path to the restic binary. Defaults to RESTIC_BIN, then `restic` on PATH. */
  resticBin?: string;
  /**
   * Wall-clock cap per restic command. Defaults to 60s. Tests cap it tighter so
   * a bad-credential snapshot fails fast instead of burning restic's S3 retry
   * backoff (which on a hard auth failure is tens of seconds and unpredictable).
   */
  resticTimeoutMs?: number;
  /** Prompt session registry; injectable so tests can inspect sessions. */
  promptRegistry?: PromptRegistry;
}

/** Resolve the work directory: option > ORI_WORK_DIR > /home/user. */
export function resolveWorkDirSetting(opts: { workDir?: string }): string {
  return opts.workDir ?? process.env.ORI_WORK_DIR ?? DEFAULT_WORK_DIR;
}

/** Resolve the env file path: option > ORI_ENV_FILE > /etc/ori.env. */
export function resolveEnvFileSetting(opts: { envFile?: string }): string {
  return opts.envFile ?? process.env.ORI_ENV_FILE ?? DEFAULT_ENV_FILE;
}

/** Used bytes on the given path's filesystem via statfs. */
export async function defaultDiskUsedBytes(path = "/"): Promise<number> {
  const s = await statfs(path);
  return (s.blocks - s.bfree) * s.bsize;
}

/**
 * The in-ori guest agent. Authenticates every request with the per-ori agent
 * token (constant-time compare) and answers /health for the control plane.
 * New endpoints (exec, files, env, …) are added under the same bearer guard in
 * later P4 tasks — the route table is shaped to take them.
 */
export function createGuestAgentApp(opts: GuestAgentOptions) {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const agentTokenHash = sha256Hex(opts.agentToken);
  const prompts = opts.promptRegistry ?? new PromptRegistry();

  const app = new Hono();

  // Structured request logging: one JSON line per request, never the token.
  app.use("*", async (c, next) => {
    const t0 = now();
    await next();
    const line = {
      ts: new Date().toISOString(),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: now() - t0,
    };
    opts.onLog?.(line);
    console.log(JSON.stringify(line));
  });

  // Bearer auth against the agent token, constant-time.
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    if (!token || !timingSafeEqualHex(sha256Hex(token), agentTokenHash)) {
      // A failed auth never reveals whether the ori (or any resource) exists.
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/health", async (c) => {
    const disk = opts.diskUsedBytes ? await opts.diskUsedBytes() : await defaultDiskUsedBytes();
    return c.json({
      ok: true,
      oriId: opts.oriId,
      uptimeSeconds: Math.floor((now() - startedAt) / 1000),
      diskUsedBytes: disk,
    });
  });

  /**
   * POST /clock — step the guest's system clock. A snapshot-resumed VM wakes with its
   * clock frozen at suspend time, so the control plane sends the epoch it wants and we
   * `date -s` into place (the agent runs as root). The sanity window is validated
   * against the guest's own clock, and the token is never part of the response.
   */
  app.post("/clock", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ ok: false, error: "invalid JSON" }, 400);
    const parsed = parseClockRequest(body, now());
    if (!parsed.ok) return c.json({ ok: false, error: parsed.message }, 400);
    try {
      const result = await runClock(parsed.value.epochMs, { now, runDate: opts.clockRunner });
      return c.json(result);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  app.post("/exec", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ ok: false, error: "invalid JSON" }, 400);
    const parsed = parseExecRequest(body);
    if (!parsed.ok) return c.json({ ok: false, error: parsed.message }, 400);

    try {
      const result = await runCommand({
        oriId: opts.oriId,
        command: parsed.value.command,
        cwd: parsed.value.cwd,
        timeoutSeconds: parsed.value.timeoutSeconds,
        workDir: resolveWorkDirSetting(opts),
      });
      return c.json(result);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  app.get("/file", async (c) => {
    const path = c.req.query("path");
    if (path === undefined || path === "") return c.json({ ok: false, error: "path is required" }, 400);
    let encoding: "utf8" | "base64";
    try {
      encoding = normalizeEncoding(c.req.query("encoding"));
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
    try {
      const result = await readFileInWorkDir({ oriId: opts.oriId, path, workDir: resolveWorkDirSetting(opts) }, encoding);
      return c.json(result);
    } catch (e) {
      if (e instanceof FileError) return c.json({ ok: false, error: e.message }, e.status);
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  app.get("/artifact", async (c) => {
    const path = c.req.query("path");
    if (path === undefined || path === "") return c.json({ ok: false, error: "path is required" }, 400);
    try {
      const { stream, contentType } = await openArtifact(resolveWorkDirSetting(opts), path);
      // Stream the bytes straight to the client; never buffer the artifact.
      return new Response(stream as unknown as ReadableStream, {
        status: 200,
        headers: { "content-type": contentType },
      });
    } catch (e) {
      if (e instanceof FileError) return c.json({ ok: false, error: e.message }, e.status);
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  app.put("/file", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ ok: false, error: "invalid JSON" }, 400);
    if (typeof body !== "object" || body === null) return c.json({ ok: false, error: "invalid body" }, 400);
    const { path, content } = body as { path?: unknown; content?: unknown };
    if (typeof path !== "string" || path === "") return c.json({ ok: false, error: "path is required" }, 400);
    if (typeof content !== "string") return c.json({ ok: false, error: "content is required" }, 400);

    let encoding: "utf8" | "base64";
    try {
      encoding = normalizeEncoding((body as { encoding?: unknown }).encoding as string | undefined);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
    try {
      const result = await writeFileInWorkDir({ oriId: opts.oriId, path, workDir: resolveWorkDirSetting(opts) }, content, encoding);
      return c.json(result);
    } catch (e) {
      if (e instanceof FileError) return c.json({ ok: false, error: e.message }, e.status);
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  app.post("/env", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ ok: false, error: "invalid JSON" }, 400);
    if (typeof body !== "object" || body === null) return c.json({ ok: false, error: "invalid body" }, 400);
    const { vars, files } = body as { vars?: unknown; files?: unknown };
    if (vars !== undefined && (typeof vars !== "object" || vars === null || Array.isArray(vars))) {
      return c.json({ ok: false, error: "vars must be an object" }, 400);
    }
    if (files !== undefined && !Array.isArray(files)) {
      return c.json({ ok: false, error: "files must be an array" }, 400);
    }

    try {
      await applyEnv({
        oriId: opts.oriId,
        vars: (vars ?? {}) as Record<string, string>,
        files: (files ?? []) as { path: string; contents: string }[],
        envFile: resolveEnvFileSetting(opts),
        workDir: resolveWorkDirSetting(opts),
      });
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof FileError) return c.json({ ok: false, error: e.message }, e.status);
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  app.post("/snapshot", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ ok: false, error: "invalid JSON" }, 400);
    const parsed = parseSnapshotRequest(body);
    if (!parsed.ok) return c.json({ ok: false, error: parsed.message }, 400);

    try {
      const result = await runSnapshot({
        oriId: opts.oriId,
        mode: parsed.value.mode,
        storage: parsed.value.storage,
        workDir: resolveWorkDirSetting(opts),
        volumesDir: opts.volumesDir,
        etcBaselinePath: opts.etcBaselinePath,
        resticBin: opts.resticBin,
        resticTimeoutMs: opts.resticTimeoutMs,
      });
      return c.json(result);
    } catch (e) {
      // A failed snapshot is a failed snapshot (needs the truth),
      // and the repo password / S3 secret never leaves the ori in a message.
      const message = redactSecrets(parsed.value.storage, (e as Error).message);
      return c.json({ ok: false, error: message }, 500);
    }
  });

  /**
   * POST /restore — put the disk back from a snapshot. Restores the work dir, then
   * re-applies the sysdiff so enabled units and /etc changes survive, which is what ori
   * promises ("Files, installed packages, and enabled systemd services do. Hand-run
   * processes do not."). Machine identity is never restored: giving every fork of a ori the
   * same ssh host keys is the bug the image's per-boot keygen exists to prevent.
   */
  app.post("/restore", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object") return c.json({ ok: false, error: "invalid JSON" }, 400);
    const { snapshotRef, storage, scrubEnv, reconcilePackages } = body as Record<string, unknown>;
    if (typeof snapshotRef !== "string" || snapshotRef.length === 0) {
      return c.json({ ok: false, error: "snapshotRef is required" }, 400);
    }
    if (typeof storage !== "object" || storage === null) {
      return c.json({ ok: false, error: "storage is required" }, 400);
    }
    try {
      const result = await runRestore({
        oriId: opts.oriId,
        snapshotRef,
        storage: storage as never,
        workDir: resolveWorkDirSetting(opts),
        volumesDir: opts.volumesDir,
        resticBin: opts.resticBin,
        scrubEnv: scrubEnv === true,
        reconcilePackages: reconcilePackages === true,
      });
      return c.json(result);
    } catch (e) {
      // Redacted: a restore error can carry the repo url, which embeds nothing secret, but
      // the message may quote argv. Keep it to the reason.
      return c.json({ ok: false, error: `restore failed: ${(e as Error).message.slice(0, 300)}` }, 500);
    }
  });

  /**
   * POST /sshkey — authorise a public key so the caller can ssh in. Ori's CLI works this
   * way: keep a key locally, push the public half, exec the system ssh.
   */
  app.post("/sshkey", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object") return c.json({ ok: false, error: "invalid JSON" }, 400);
    try {
      const result = await authorizeKey({
        workDir: resolveWorkDirSetting(opts),
        key: (body as { key?: unknown }).key as string,
      });
      return c.json(result);
    } catch (e) {
      if (e instanceof SshKeyError) return c.json({ ok: false, error: e.message }, e.status);
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  /**
   * POST /prompt — start a provider CLI (codex / claude-code) on the ori's own credentials.
   * One active prompt at a time: a second start while one is running is a 409.
   */
  app.post("/prompt", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object") return c.json({ ok: false, error: "invalid JSON" }, 400);
    const { promptId, provider, model, reasoningEffort, prompt } = body as Record<string, unknown>;
    if (typeof promptId !== "string" || promptId.length === 0) return c.json({ ok: false, error: "promptId is required" }, 400);
    if (typeof provider !== "string" || !["codex", "claude-code", "claude"].includes(provider)) {
      return c.json({ ok: false, error: "provider must be codex or claude-code" }, 400);
    }
    if (typeof prompt !== "string" || prompt.trim().length === 0) return c.json({ ok: false, error: "prompt is required" }, 400);
    if (prompts.active) return c.json({ ok: false, error: "an agent run is already active in this ori" }, 409);

    const installed = await providerInstalled(provider);
    if (!installed) return c.json({ ok: false, error: `provider "${provider}" is not installed in this ori` }, 409);

    const session = new PromptSession(promptId, provider);
    prompts.add(session);
    const cmd = providerCommand({
      oriId: opts.oriId,
      promptId,
      provider,
      model: typeof model === "string" ? model : null,
      reasoningEffort: typeof reasoningEffort === "string" ? reasoningEffort : null,
      prompt,
      workDir: resolveWorkDirSetting(opts),
    });
    // Fire-and-forget: the control plane drains lines via GET /prompt/:id/status.
    void runPromptSession(session, cmd, resolveWorkDirSetting(opts)).finally(() => prompts.prune());
    return c.json({ ok: true, ...session.state() });
  });

  /**
   * GET /prompt/:promptId/status — the run state plus any new captured lines since `from`.
   * The control plane polls this while the prompt runs; `from` is an index into the line
   * buffer, so a missed poll never loses lines — they are re-drained on the next call.
   */
  app.get("/prompt/:promptId/status", async (c) => {
    const session = prompts.get(c.req.param("promptId"));
    if (!session) return c.json({ ok: false, error: "no such prompt run" }, 404);
    const from = Number(c.req.query("from") ?? 0) || 0;
    const state = session.state();
    return c.json({ ok: true, ...state, lines: session.lines.slice(from) });
  });

  /**
   * POST /interrupt — stop the active agent run: kill its process group, mark the session
   * finished, and leave the lines already captured readable.
   */
  app.post("/interrupt", async (c) => {
    const active = prompts.active;
    if (!active) return c.json({ ok: true, interrupted: false, error: null });
    active.kill("SIGTERM");
    // The exit handler will finish() the session; give it a moment so the status read
    // after this call reflects the interruption.
    await Promise.race([active.exited(), Bun.sleep(1500)]);
    if (!active.done) {
      active.kill("SIGKILL");
      active.finish(null, "interrupted");
    }
    return c.json({ ok: true, interrupted: true, promptId: active.promptId });
  });

  /**
   * POST /host — the in-box `host` CLI: register/re-register a hosted port with the control
   * plane (machine-token auth). Body {port, title?, public?}.
   */
  app.post("/host", async (c) => {
    const env = hostEnvFromProcess();
    if (!env) return c.json({ ok: false, error: "host env (ORI_MACHINE_TOKEN/ORI_CONTROL_PLANE) is not configured in this ori" }, 500);
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object") return c.json({ ok: false, error: "invalid JSON" }, 400);
    const { port, title, public: isPublic } = body as Record<string, unknown>;
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return c.json({ ok: false, error: "port must be an integer 1-65535" }, 400);
    try {
      const route = await hostPort(env, p, typeof title === "string" ? title : undefined, isPublic === true);
      return c.json({ ok: true, ...route });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 502);
    }
  });

  /** GET /host — `host list`. */
  app.get("/host", async (c) => {
    const env = hostEnvFromProcess();
    if (!env) return c.json({ ok: false, error: "host env is not configured in this ori" }, 500);
    try {
      return c.json({ ok: true, routes: await hostList(env) });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 502);
    }
  });

  /** GET /host/url?port= — `host url <port>`, registering first if needed. */
  app.get("/host/url", async (c) => {
    const env = hostEnvFromProcess();
    if (!env) return c.json({ ok: false, error: "host env is not configured in this ori" }, 500);
    const port = Number(c.req.query("port"));
    if (!Number.isInteger(port) || port < 1) return c.json({ ok: false, error: "port is required" }, 400);
    try {
      const route = await hostUrl(env, port, c.req.query("public") === "1");
      return c.json({ ok: true, ...route });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 502);
    }
  });

  /** DELETE /host?port= — `host hide <port>`. */
  app.delete("/host", async (c) => {
    const env = hostEnvFromProcess();
    if (!env) return c.json({ ok: false, error: "host env is not configured in this ori" }, 500);
    const port = Number(c.req.query("port"));
    if (!Number.isInteger(port) || port < 1) return c.json({ ok: false, error: "port is required" }, 400);
    try {
      await hostHide(env, port);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 502);
    }
  });

  /**
   * GET /desktop/start and /desktop/stop — the desktop is lazy by design (the units ship
   * disabled), so it is brought up on demand and torn down when nobody wants it.
   */
  app.get("/desktop/start", async (c) => {
    const status = await startDesktop();
    return c.json(status, status.ok ? 200 : 500);
  });

  app.get("/desktop/stop", async (c) => {
    return c.json(await stopDesktop());
  });

  return app;
}
