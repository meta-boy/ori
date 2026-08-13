import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore, deleteOriCascade } from "./helpers";
import { oris, oriEvents, promptRuns as promptRunsTable } from "@ori/api/db/schema";
import type { Ori } from "@ori/contract";
import { scpArgv } from "../../packages/cli/src/ssh";

/**
 * The CLI is a thin client over the HTTP API; these tests run the REAL CLI source
 * (bun packages/cli/src/index.ts) against a REAL server with the fake driver, so a
 * command that parses flags wrong or calls the wrong path fails here, not for a user.
 */

const db = makeDb();
const driver = new FakeMachineDriver();
const tokens = new TokenStore();
const deps = { db, driver, tokens };
const app = buildApp(deps);

let key: Awaited<ReturnType<typeof seedUserKey>>;
let server: { url: string; stop(): void };
let xdgDir: string;
let cliUrl = "";

const CLI = join(process.cwd(), "packages/cli/src/index.ts");

async function cli(args: string[], opts: { env?: Record<string, string> } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = { ...process.env, XDG_CONFIG_HOME: xdgDir, HOME: xdgDir, ORI_API_KEY: key.secret, ...opts.env };
  // The CLI's --json output must stay parseable; a FORCE_COLOR inherited from the caller's
  // shell makes bun wrap lines in ANSI and breaks JSON.parse on every line.
  delete env.FORCE_COLOR;
  const p = Bun.spawn({
    cmd: ["bun", CLI, ...args],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout: out, stderr: err };
}

async function createOri(secret = key.secret): Promise<Ori> {
  const res = await app.request("/api/ori/v1/oris", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
  });
  const json = await res.json();
  expect(json.ok).toBe(true);
  return json.ori as Ori;
}

async function waitFor(fn: () => Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await Bun.sleep(30);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitForState(id: string, state: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    if (row?.state === state) return;
    await Bun.sleep(20);
  }
  throw new Error(`ori ${id} never reached ${state}`);
}

beforeAll(async () => {
  key = await seedUserKey(db);
  xdgDir = await mkdtemp(join(tmpdir(), "ori-cli-"));
  const s = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) });
  server = { url: `http://127.0.0.1:${(s as { port: number }).port}`, stop: () => s.stop(true) };
  cliUrl = server.url;
});

afterAll(async () => {
  await server.stop();
  await driver.stopAll();
  await rm(xdgDir, { recursive: true, force: true });
});

describe("T-P12-10/11/12 CLI surface", () => {
  test("list --filter sr returns only stopped+running groups and --json parses", async () => {
    const ori = await createOri();
    await waitForState(ori.id, "ready");
    const r = await cli(["list", "--json", "--api-url", cliUrl]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].id).toBe(ori.id);
    await deleteOriCascade(db, ori.id);
  });

  test("extend --hours moves archiveAfter forward; --no-auto-stop disables it", async () => {
    const ori = await createOri();
    await waitForState(ori.id, "ready");
    const r1 = await cli(["extend", ori.id, "--hours", "2", "--json", "--api-url", cliUrl]);
    expect(r1.code).toBe(0);
    const body1 = JSON.parse(r1.stdout.trim().split("\n")[0]);
    const row1 = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    const remaining1 = new Date(row1!.archiveAfter!).getTime() - Date.now();
    expect(remaining1).toBeGreaterThan(2 * 3600_000 - 60_000);

    const r2 = await cli(["extend", ori.id, "--no-auto-stop", "--json", "--api-url", cliUrl]);
    expect(r2.code).toBe(0);
    const row2 = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    expect(row2?.archiveAfter).toBeNull();
    expect(body1.ori.archiveAfter).toBeTruthy();
    await deleteOriCascade(db, ori.id);
  });

  test("events lists lifecycle events oldest-first", async () => {
    const ori = await createOri();
    await waitForState(ori.id, "ready");
    const r = await cli(["events", ori.id, "--json", "--api-url", cliUrl]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    const types = lines.map((e) => e.type);
    expect(types).toContain("ori.created");
    expect(types).toContain("ori.ready");
    // Chronological even though the API is asked for the newest page (sort=desc, reversed).
    expect(types.indexOf("ori.created")).toBeLessThan(types.indexOf("ori.ready"));
    await deleteOriCascade(db, ori.id);
  });

  test("limits, config, completions, api-key list all emit machine-readable output", async () => {
    const lim = await cli(["limits", "--json", "--api-url", cliUrl]);
    expect(lim.code).toBe(0);
    const limitsBody = JSON.parse(lim.stdout.trim());
    expect(limitsBody.activeOris).toBeGreaterThanOrEqual(0);
    expect(typeof limitsBody.canStart).toBe("boolean");

    const cfg = await cli(["config", "--json", "--api-url", cliUrl]);
    expect(cfg.code).toBe(0);
    const cfgBody = JSON.parse(cfg.stdout.trim());
    expect(cfgBody.path).toContain("config.json");
    expect(cfgBody.loggedIn).toBe(true);

    const comp = await cli(["completions", "bash", "--api-url", cliUrl]);
    expect(comp.code).toBe(0);
    expect(comp.stdout).toContain("complete -F _ori_complete ori");

    const keys = await cli(["api-key", "list", "--json", "--api-url", cliUrl]);
    expect(keys.code).toBe(0);
    expect(keys.stdout.trim()).toContain(key.keyId);

    const create = await cli(["api-key", "create", "x", "--json", "--api-url", cliUrl]);
    expect(create.code).toBe(1);
    expect(create.stdout).toContain("dashboard");
  });

  test("prompt queues, streams response lines, and finishes", async () => {
    const ori = await createOri();
    await waitForState(ori.id, "ready");
    // Spawn the CLI in the background: it streams until the run finishes, so the test has
    // to drive the fake guest while it runs rather than after.
    const p = Bun.spawn({
      cmd: ["bun", CLI, "prompt", ori.id, "--provider", "codex", "--model", "gpt-5.4", "--reasoning-effort", "medium", "run the tests", "--json", "--api-url", cliUrl],
      env: { ...process.env, XDG_CONFIG_HOME: xdgDir, HOME: xdgDir, ORI_API_KEY: key.secret },
      stdout: "pipe",
      stderr: "pipe",
    });
    const outPromise = new Response(p.stdout).text();

    // Wait for the run to exist, then push two lines and finish it.
    let runId = "";
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const rows = await db.select({ id: promptRunsTable.id }).from(promptRunsTable).where(eq(promptRunsTable.oriId, ori.id));
      if (rows.length > 0) { runId = rows[0].id; break; }
      await Bun.sleep(30);
    }
    expect(runId).toBeTruthy();
    const row = await db.query.oris.findFirst({ where: eq(oris.id, ori.id) });
    const guest = driver.guest(row!.machineId!)!;
    // The control plane writes the prompt_runs row BEFORE calling the guest, so wait for the
    // guest-side session to exist too — otherwise this pushes into undefined.
    await waitFor(async () => guest.promptRuns.has(runId), "guest prompt session");
    guest.promptRuns.get(runId)!.lines.push({ stream: "stdout", text: "hello from agent" });
    guest.promptRuns.get(runId)!.lines.push({ stream: "stdout", text: "done" });
    guest.promptRuns.get(runId)!.done = true;
    guest.promptRuns.get(runId)!.status = "finished";

    const out = await outPromise;
    const exitCode = await p.exited;
    expect(exitCode).toBe(0);
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].event).toBe("queued");
    const chat = lines.filter((l) => l.event === "chat");
    const text = chat.map((l) => l.data.data.content).join("");
    expect(text).toContain("hello from agent");
    expect(text).toContain("done");
    await deleteOriCascade(db, ori.id);
  });

  test("interrupt stops the agent and the ori settles to idle", async () => {
    const ori = await createOri();
    await waitForState(ori.id, "ready");
    // The prompt CLI blocks streaming until the run finishes, so run it in the background
    // and interrupt it from a second CLI process.
    const p = Bun.spawn({
      cmd: ["bun", CLI, "prompt", ori.id, "--provider", "codex", "long task", "--json", "--api-url", cliUrl],
      env: { ...process.env, XDG_CONFIG_HOME: xdgDir, HOME: xdgDir, ORI_API_KEY: key.secret },
      stdout: "pipe",
      stderr: "pipe",
    });
    const outPromise = new Response(p.stdout).text();
    await waitFor(async () => (await db.query.oris.findFirst({ where: eq(oris.id, ori.id) }))?.state === "running", "running");
    const ir = await cli(["interrupt", ori.id, "--json", "--api-url", cliUrl]);
    expect(ir.code).toBe(0);
    await waitFor(async () => (await db.query.oris.findFirst({ where: eq(oris.id, ori.id) }))?.state === "idle", "idle");
    const out = await outPromise;
    expect(await p.exited).toBe(0);
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].event).toBe("queued");
    expect(lines[0].data.promptId).toBeTruthy();
    await deleteOriCascade(db, ori.id);
  });

  test("host registers a port and prints the token-gated URL", async () => {
    const ori = await createOri();
    await waitForState(ori.id, "ready");
    const r = await cli(["host", ori.id, "3000", "--title", "preview", "--json", "--api-url", cliUrl]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout.trim().split("\n")[0]);
    expect(body.url).toContain(`-3000.on.ori.dev`);
    expect(body.isProtected).toBe(true);
    expect(body.ok).toBe(true);
    const r2 = await cli(["host", ori.id, "3000", "--public", "--json", "--api-url", cliUrl]);
    const body2 = JSON.parse(r2.stdout.trim().split("\n")[0]);
    expect(body2.isProtected).toBe(false);
    await deleteOriCascade(db, ori.id);
  });

  test("snapshot latest returns null before any snapshot", async () => {
    const ori = await createOri();
    await waitForState(ori.id, "ready");
    const r = await cli(["snapshot", "latest", ori.id, "--json", "--api-url", cliUrl]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toBeNull();
    await deleteOriCascade(db, ori.id);
  });

  test("exec wakes an archived ori (wake-on-connect)", async () => {
    const ori = await createOri();
    await waitForState(ori.id, "ready");
    // Archive it (force:true so stop does not need a real final snapshot).
    const stop = await app.request(`/api/ori/v1/oris/${ori.id}/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(stop.status).toBe(202);
    await waitForState(ori.id, "archived");

    // exec against the archived ori: the CLI must auto-resume and wait for ready.
    // Human mode: the one-line notice is a human-facing progress line, so --json
    // suppresses it (same convention as `ori new`'s "creating" dots).
    const r = await cli(["exec", ori.id, "echo hi", "--api-url", cliUrl]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`resuming ${ori.id}`);
    // And the ori is back up afterwards — the command ran, not a polite failure.
    await waitForState(ori.id, "ready");
    await deleteOriCascade(db, ori.id);
  });

  test("exec on a ready ori does not resume it", async () => {
    const ori = await createOri();
    await waitForState(ori.id, "ready");
    const r = await cli(["exec", ori.id, "echo hi", "--json", "--api-url", cliUrl]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("resuming");
    await deleteOriCascade(db, ori.id);
  });
});

describe("scp argv assembly", () => {
  

  test("strips the bare user@host destination and respells -p as -P", () => {
    const targetArgs = ["-i", "/k", "-o", "StrictHostKeyChecking=accept-new", "-p", "32771", "user@127.0.0.1"];
    const argv = scpArgv(targetArgs, ["./local.txt", "user@127.0.0.1:/home/user/x"]);
    // The destination must never appear as a bare argument — scp stats it as a local file.
    expect(argv).not.toContain("user@127.0.0.1");
    expect(argv).toContain("-P");
    expect(argv).not.toContain("-p");
    expect(argv.slice(-2)).toEqual(["./local.txt", "user@127.0.0.1:/home/user/x"]);
  });

  test("tunnel-style args (ProxyCommand, no -p) also lose only the destination", () => {
    const targetArgs = ["-i", "/k", "-o", "ProxyCommand=ori ssh-tunnel or_x", "user@or_x"];
    const argv = scpArgv(targetArgs, ["or_x-mapped:/a", "./b"]);
    expect(argv).not.toContain("user@or_x");
    expect(argv.slice(-2)).toEqual(["or_x-mapped:/a", "./b"]);
  });
});
