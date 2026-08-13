import type { RequestableMachineType } from "@ori/contract";
import { snapshotId, validateSecretPath } from "@ori/contract";
import { sha256Hex, timingSafeEqualHex } from "../middleware/auth";
import type { MachineCreateInput, MachineDriver, SuspendableDriver, WarmFootprintDriver } from "./types";

/** Mirrors the real guest agent's /file cap (packages/guest-agent/src/file.ts). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Minimal ustar tar of the given `{name, content}` entries — used by /artifact. */
function buildTar(entries: { name: string; content: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const header = Buffer.alloc(512);
    nameBuf.copy(header, 0, 0, Math.min(nameBuf.length, 100));
    header.write("0000644\0", 100, 8); // mode
    header.write("0000000\0", 108, 8); // uid
    header.write("0000000\0", 116, 8); // gid
    const sizeOctal = content.length.toString(8).padStart(11, "0");
    header.write(`${sizeOctal}\0`, 124, 12);
    header.write("00000000000\0", 136, 12); // mtime
    header.write("        ", 148, 8); // checksum placeholder (spaces)
    header[156] = 0x30; // typeflag '0' = regular file
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0"), 148, 6);
    blocks.push(header, content);
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks end the archive
  return Buffer.concat(blocks);
}

/**
 * In-process guest agent for the fake driver. Implements the §5 guest API and
 * is served over real loopback HTTP (`127.0.0.1:<port>`), so the control plane
 * talks to it through the same client code it will use against a real ori.
 */
export class FakeGuestAgent {
  readonly oriId: string;
  readonly agentTokenHash: string;

  uptimeSeconds = 42;
  diskUsedBytes = 512 * 1024 * 1024;
  failHealth = false;
  failSnapshot = false;
  failRestore = false;
  /**
   * Simulate the first seconds of a real machine's life, when systemd is up but
   * ori-agent.service is not listening yet: every route refuses, not just /health. A real
   * agent in that window answers nothing at all, and code that dialled /restore during it
   * was how forks and cold resumes died on `guest POST /restore: unreachable`.
   */
  unhealthyUntilMs = 0;

  files = new Map<string, Buffer>();
  authorizedKeys: string[] = [];
  envVars = new Map<string, string>();
  secretFiles = new Map<string, string>();
  snapshots: { snapshotId: string; generation: number; sizeBytes: number; fileCount: number }[] = [];
  lastRestore: { snapshotRef: string; scrubEnv: boolean } | null = null;
  lastPrompt: Record<string, unknown> | null = null;
  interruptCalls = 0;
  /** Simulated prompt runs keyed by promptId; tests push lines and flip done. */
  promptRuns = new Map<string, { status: string; done: boolean; lines: { stream: string; text: string }[] }>();
  desktopStarted = false;
  hostCalls: { port: number; title: string; public: boolean }[] = [];
  execCalls: { command: string; cwd?: string; timeoutSeconds?: number }[] = [];
  scriptedExec = { exitCode: 0, stdout: "", stderr: "" };

  constructor(oriId: string, agentToken: string) {
    this.oriId = oriId;
    this.agentTokenHash = sha256Hex(agentToken);
  }

  /** Timing-safe bearer check used by every §5 endpoint. */
  verifyToken(token: string | null): boolean {
    if (!token) return false;
    return timingSafeEqualHex(sha256Hex(token), this.agentTokenHash);
  }

  /* ------------------------------- §5 API ------------------------------- */

  async health(): Promise<{ ok: boolean; oriId: string; uptimeSeconds: number; diskUsedBytes: number }> {
    return {
      ok: !this.failHealth,
      oriId: this.oriId,
      uptimeSeconds: this.uptimeSeconds,
      diskUsedBytes: this.diskUsedBytes,
    };
  }

  async exec(req: { command: string; cwd?: string; timeoutSeconds?: number }) {
    this.execCalls.push(req);
    // Mirror the real guest agent's validation so the control plane's error
    // translation is exercised end-to-end: a rejected cwd or an out-of-range
    // timeoutSeconds is a 400, never a clamped success.
    if (req.cwd !== undefined && (req.cwd.startsWith("/") || req.cwd.split("/").includes(".."))) {
      return { ok: false, error: `invalid cwd: ${req.cwd}` };
    }
    if (req.timeoutSeconds !== undefined && (req.timeoutSeconds < 1 || req.timeoutSeconds > 60)) {
      return { ok: false, error: `invalid timeoutSeconds: ${req.timeoutSeconds}` };
    }
    const now = new Date().toISOString();
    return {
      ok: true,
      type: "command.finished",
      success: this.scriptedExec.exitCode === 0,
      exitCode: this.scriptedExec.exitCode,
      signal: null,
      stdout: this.scriptedExec.stdout,
      stderr: this.scriptedExec.stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cwd: req.cwd ?? "/home/user",
      startedAt: now,
      finishedAt: now,
    };
  }

  async readFile(path: string, encoding: string) {
    const v = validateSecretPath(path);
    if (!v.ok) return { ok: false, error: v.message, status: 400 };
    const bytes = this.files.get(path);
    if (bytes === undefined) {
      return { ok: false, code: "not_found", message: `no such file: ${path}`, status: 404 };
    }
    if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: `file exceeds ${MAX_FILE_BYTES} bytes`, status: 400 };
    return {
      ok: true,
      type: "file.read",
      success: true,
      path,
      encoding,
      size: bytes.length,
      content: encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8"),
    };
  }

  async writeFile(req: { path: string; content: string; encoding: string }) {
    const v = validateSecretPath(req.path);
    if (!v.ok) return { ok: false, error: v.message, status: 400 };
    // Store the raw bytes (like a real disk), NOT a utf8 round-trip: a utf8
    // detour would corrupt any byte above 0x7f and silently break binary
    // round-trips. The base64 read path re-encodes from these bytes.
    const bytes = req.encoding === "base64" ? Buffer.from(req.content, "base64") : Buffer.from(req.content, "utf8");
    if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: `content exceeds ${MAX_FILE_BYTES} bytes`, status: 400 };
    this.files.set(req.path, bytes);
    return {
      ok: true,
      type: "file.written",
      success: true,
      path: req.path,
      encoding: req.encoding,
      size: bytes.length,
    };
  }

  /**
   * Stream an artifact: a single file's bytes, or a folder's files as a tar.
   * In-process fake returns a Response whose body the control plane relays.
   */
  async artifact(path: string): Promise<Response> {
    const v = validateSecretPath(path);
    if (!v.ok) return Response.json({ ok: false, error: v.message }, { status: 400 });
    const content = this.files.get(path);
    if (content !== undefined) {
      return new Response(new Uint8Array(content), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    // folder: tar every file whose key is under `path/`
    const prefix = `${path}/`;
    const entries = [...this.files.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ name: key.slice(prefix.length), content: value }));
    if (entries.length === 0) return Response.json({ ok: false, error: `no such artifact: ${path}` }, { status: 404 });
    return new Response(new Uint8Array(buildTar(entries)), {
      status: 200,
      headers: { "content-type": "application/x-tar" },
    });
  }

  async sshkey(key: string) {
    this.authorizedKeys.push(key);
    return { ok: true };
  }

  async snapshot(mode: "auto" | "final") {
    if (this.failSnapshot) throw new Error("injected snapshot failure");
    const generation = this.snapshots.length + 1;
    const snap = {
      snapshotId: snapshotId(),
      generation,
      sizeBytes: 1_048_576 * generation,
      fileCount: 10 * generation,
    };
    this.snapshots.push(snap);
    return snap;
  }

  async restore(snapshotRef: string, scrubEnv: boolean) {
    if (this.failRestore) throw new Error("injected restore failure");
    this.lastRestore = { snapshotRef, scrubEnv };
    return { ok: true };
  }

  async env(vars: Record<string, string>, files: { path: string; contents: string }[]) {
    for (const [k, v] of Object.entries(vars)) this.envVars.set(k, v);
    for (const f of files) this.secretFiles.set(f.path, f.contents);
    return { ok: true };
  }

  async prompt(payload: Record<string, unknown>) {
    this.lastPrompt = payload;
    const promptId = payload.promptId as string;
    this.promptRuns.set(promptId, { status: "running", done: false, lines: [] });
    return { ok: true, promptId, status: "queued" };
  }

  async promptStatus(promptId: string, from: number) {
    const run = this.promptRuns.get(promptId);
    if (!run) return { ok: false, error: "no such prompt run" };
    return {
      ok: true,
      promptId,
      provider: "codex",
      status: run.status,
      done: run.done,
      exitCode: run.done ? 0 : null,
      error: null,
      lineCount: run.lines.length,
      lines: run.lines.slice(from),
    };
  }

  async interrupt() {
    this.interruptCalls++;
    for (const run of this.promptRuns.values()) {
      if (!run.done) {
        run.done = true;
        run.status = "interrupted";
      }
    }
    return { ok: true, interrupted: true };
  }

  async desktopStart() {
    this.desktopStarted = true;
    return { ok: true };
  }

  async desktopStop() {
    this.desktopStarted = false;
    return { ok: true };
  }

  async host(port: number, title: string, isPublic: boolean) {
    this.hostCalls.push({ port, title, public: isPublic });
    return { ok: true };
  }

  /* --------------------------- HTTP routing ----------------------------- */

  /** Route a raw request through the §5 guest API, enforcing bearer auth. */
  async handle(req: Request): Promise<Response> {
    const auth = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    if (!this.verifyToken(auth)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    // Not up yet: refuse everything, the way a socket nobody is listening on does.
    if (Date.now() < this.unhealthyUntilMs) {
      return Response.json({ ok: false, error: "agent not started" }, { status: 503 });
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const json = async () => (method === "POST" || method === "PUT" ? ((await req.json()) as Record<string, any>) : {});

    try {
      if (method === "GET" && path === "/health") return Response.json(await this.health(), { status: this.failHealth ? 503 : 200 });
      if (method === "POST" && path === "/exec") {
        const result = await this.exec((await json()) as any);
        return Response.json(result, { status: (result as any).ok ? 200 : 400 });
      }
      if (method === "GET" && path === "/file") {
        const res = await this.readFile(url.searchParams.get("path") ?? "", url.searchParams.get("encoding") ?? "utf8");
        return Response.json(res, { status: (res as any).ok ? 200 : ((res as any).status ?? 404) });
      }
      if (method === "PUT" && path === "/file") {
        const res = await this.writeFile((await json()) as any);
        return Response.json(res, { status: (res as any).ok ? 200 : ((res as any).status ?? 400) });
      }
      if (method === "GET" && path === "/artifact") {
        return this.artifact(url.searchParams.get("path") ?? "");
      }
      if (method === "POST" && path === "/sshkey") return Response.json(await this.sshkey(((await json()) as any).key));
      if (method === "POST" && path === "/snapshot") return Response.json(await this.snapshot(((await json()) as any).mode));
      if (method === "POST" && path === "/restore") {
        const body = (await json()) as any;
        return Response.json(await this.restore(body.snapshotRef, body.scrubEnv));
      }
      if (method === "POST" && path === "/env") {
        const body = (await json()) as any;
        return Response.json(await this.env(body.vars ?? {}, body.files ?? []));
      }
      if (method === "POST" && path === "/prompt") return Response.json(await this.prompt((await json()) as any));
      if (method === "GET" && path.startsWith("/prompt/") && path.endsWith("/status")) {
        const promptId = path.slice("/prompt/".length, -"/status".length);
        const from = Number(url.searchParams.get("from") ?? 0) || 0;
        const res = await this.promptStatus(promptId, from);
        return Response.json(res, { status: (res as any).ok ? 200 : 404 });
      }
      if (method === "POST" && path === "/interrupt") return Response.json(await this.interrupt());
      if (method === "GET" && path === "/desktop/start") return Response.json(await this.desktopStart());
      if (method === "GET" && path === "/desktop/stop") return Response.json(await this.desktopStop());
      if (method === "POST" && path === "/host") {
        const body = (await json()) as any;
        return Response.json(await this.host(body.port, body.title, body.public));
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message ?? "error" }, { status: 500 });
    }
  }
}

interface FakeMachine {
  machineId: string;
  oriId: string;
  type: RequestableMachineType;
  image: string;
  machineToken: string;
  agentToken: string;
  ip: string;
  guest: FakeGuestAgent;
  server: { stop(): void };
  alive: boolean;
}

/**
 * In-memory MachineDriver. Machines live on loopback with real HTTP guest
 * agents, so the control-plane guest client works unchanged against the fake.
 */
export class FakeMachineDriver implements MachineDriver, SuspendableDriver, WarmFootprintDriver {
  private machines = new Map<string, FakeMachine>();
  private seq = 0;

  failNextCreate = false;
  failNextDestroy = false;

  /**
   * Milliseconds the NEXT created machine's guest agent stays unreachable, so a test can
   * reproduce a slow-booting host. Consumed by the next `create`, like `failNextCreate`.
   */
  nextGuestUnhealthyMs = 0;

  /** Number of machines ever created (never decreases after destroy). */
  createdCount = 0;
  destroyedCount = 0;

  /** Injectable warm-tier footprint: machineId -> host bytes + archive time (test hook). */
  warmFootprintByMachine = new Map<string, { bytes: number; archivedAtMs: number | null }>();

  get liveCount(): number {
    return this.machines.size;
  }

  async create(input: MachineCreateInput): Promise<{ machineId: string; ip: string }> {
    this.createdCount++;
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("injected create failure");
    }
    const machineId = `m_${++this.seq}`;
    const guest = new FakeGuestAgent(input.oriId, input.agentToken);
    if (this.nextGuestUnhealthyMs > 0) {
      guest.unhealthyUntilMs = Date.now() + this.nextGuestUnhealthyMs;
      this.nextGuestUnhealthyMs = 0;
    }
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => guest.handle(req) });
    const ip = `127.0.0.1:${(server as { port: number }).port}`;
    this.machines.set(machineId, {
      machineId,
      oriId: input.oriId,
      type: input.type,
      image: input.image,
      machineToken: input.machineToken,
      agentToken: input.agentToken,
      ip,
      guest,
      server,
      alive: true,
    });
    return { machineId, ip };
  }

  async destroy(machineId: string): Promise<void> {
    const m = this.machines.get(machineId);
    if (!m) return;
    if (this.failNextDestroy) {
      this.failNextDestroy = false;
      throw new Error("injected destroy failure");
    }
    this.destroyedCount++;
    m.alive = false;
    m.server.stop();
    this.machines.delete(machineId);
  }

  async ip(machineId: string): Promise<string | null> {
    return this.machines.get(machineId)?.ip ?? null;
  }

  async isAlive(machineId: string): Promise<boolean> {
    return this.machines.get(machineId)?.alive ?? false;
  }

  /**
   * Warm stop: the machine stays on "host disk" — the loopback server keeps running — but is
   * no longer alive. destroy() is what takes the server down for real. Mirrors docker's stop,
   * where the container is halted in place, not removed.
   */
  async stop(machineId: string): Promise<void> {
    const m = this.machines.get(machineId);
    if (!m) return;
    m.alive = false;
  }

  /**
   * Warm start: mark the machine alive again and return its address. Mirror of docker, where a
   * start can reassign the address; the fake's loopback server is stable, so the address is
   * stable too — the caller records it either way.
   */
  async start(machineId: string): Promise<{ ip: string }> {
    const m = this.machines.get(machineId);
    if (!m) throw new Error(`no such machine: ${machineId}`);
    m.alive = true;
    return { ip: m.ip };
  }

  /** Whether the machine still exists on this host, stopped or running. */
  async exists(machineId: string): Promise<boolean> {
    return this.machines.has(machineId);
  }

  /**
   * Warm-tier footprint: the STOPPED machines that have an injected entry, with their injected
   * bytes and archive time. Stopped means warm — on host disk, not running — and a machine
   * without an injected entry is absent, mirroring the real driver only answering for machines
   * that actually hold warm artifacts.
   */
  async warmFootprint(): Promise<Map<string, { bytes: number; archivedAtMs: number | null }>> {
    const out = new Map<string, { bytes: number; archivedAtMs: number | null }>();
    for (const [machineId, m] of this.machines) {
      if (m.alive) continue;
      const fp = this.warmFootprintByMachine.get(machineId);
      if (fp) out.set(machineId, { bytes: fp.bytes, archivedAtMs: fp.archivedAtMs });
    }
    return out;
  }

  /** Fake hosting: any container port is "reachable" at a stable loopback port. */
  async hostAddress(machineId: string, containerPort: number): Promise<{ host: string; port: number } | null> {
    const m = this.machines.get(machineId);
    if (!m?.alive) return null;
    return { host: "127.0.0.1", port: 40_000 + containerPort };
  }

  /* Concrete accessors for tests (NOT part of the MachineDriver interface). */

  guest(machineId: string): FakeGuestAgent | undefined {
    return this.machines.get(machineId)?.guest;
  }

  list(): FakeMachine[] {
    return [...this.machines.values()];
  }

  async stopAll(): Promise<void> {
    for (const m of [...this.machines.values()]) {
      m.alive = false;
      m.server.stop();
    }
    this.machines.clear();
  }
}
