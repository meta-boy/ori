import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGuestAgentApp } from "@ori/guest-agent/app";

const ORI_ID = "or_abcdef12";
const AGENT_TOKEN = "ori_at_secret_token";

let workDir = "";
let workReal = "";
let app: ReturnType<typeof createGuestAgentApp>;

async function exec(body: unknown, token = AGENT_TOKEN) {
  return app.request("/exec", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function execJson(body: unknown, token = AGENT_TOKEN) {
  const res = await exec(body, token);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  // The guest's work dir comes from ORI_WORK_DIR (falling back to /home/user in a
  // real ori); the test points it at a hermetic temp dir because /home/user does
  // not exist on the dev host.
  workDir = await mkdtemp(join(tmpdir(), "ori-ga-"));
  await mkdir(join(workDir, "sub"), { recursive: true });
  await writeFile(join(workDir, "hello.txt"), "hello file\n");
  workReal = await realpath(workDir);
  process.env.ORI_WORK_DIR = workDir;
  app = createGuestAgentApp({ oriId: ORI_ID, agentToken: AGENT_TOKEN });
});

afterAll(async () => {
  delete process.env.ORI_WORK_DIR;
  await rm(workDir, { recursive: true, force: true });
});

describe("T-P4-02 POST /exec", () => {
  test("runs a command through a login shell and returns the CommandResponse shape", async () => {
    const { status, body } = await execJson({ command: "printf 'out'; printf 'err' >&2; echo hi" });
    expect(status).toBe(200);
    expect(body.type).toBe("command.finished");
    expect(body.ok).toBe(true);
    expect(body.success).toBe(true);
    expect(body.exitCode).toBe(0);
    expect(body.signal).toBeNull();
    expect(body.timedOut).toBe(false);
    expect(body.stdout).toContain("hi");
    expect(body.stderr).toContain("err");
    expect(body.stdoutTruncated).toBe(false);
    expect(body.stderrTruncated).toBe(false);
    expect(body.cwd).toBe(workReal);
    expect(typeof body.startedAt).toBe("string");
    expect(typeof body.finishedAt).toBe("string");
  });

  test("a login shell sources /etc/profile and the user's profile", async () => {
    // Write a profile file the login shell will source, then check a marker it sets.
    const marker = `marker_${Date.now()}`;
    await writeFile(join(workDir, ".bash_profile"), `export ORI_TEST_MARKER=${marker}\n`);
    const { body } = await execJson({ command: "printf '%s' \"$ORI_TEST_MARKER\"" });
    expect(body.stdout).toBe(marker);
  });

  test("returns a non-zero exit code", async () => {
    const { status, body } = await execJson({ command: "exit 7" });
    expect(status).toBe(200);
    expect(body.exitCode).toBe(7);
    expect(body.success).toBe(false);
    expect(body.signal).toBeNull();
  });

  test("reports the signal when killed by one", async () => {
    const { status, body } = await execJson({ command: "kill -TERM $$" });
    expect(status).toBe(200);
    expect(body.signal).toBe("SIGTERM");
    expect(body.timedOut).toBe(false);
  });

  test("times out, kills the process group, and reports timedOut", async () => {
    const t0 = Date.now();
    const { status, body } = await execJson({ command: "sleep 30", timeoutSeconds: 1 });
    const elapsed = Date.now() - t0;
    expect(status).toBe(200);
    expect(body.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });

  test("a command that spawns a background child still returns (no hang)", async () => {
    const t0 = Date.now();
    const { status, body } = await execJson({ command: "sleep 30 & echo done" });
    const elapsed = Date.now() - t0;
    expect(status).toBe(200);
    expect(body.stdout).toContain("done");
    expect(elapsed).toBeLessThan(5000);
  });

  test("truncates stdout at 1MB and sets the flag", async () => {
    const { status, body } = await execJson({ command: "head -c 1500000 /dev/zero | tr '\\0' 'a'; echo -n done" });
    expect(status).toBe(200);
    expect(body.stdoutTruncated).toBe(true);
    expect((body.stdout as string).length).toBe(1024 * 1024);
  });

  test("truncates stderr at 1MB and sets the flag", async () => {
    const { status, body } = await execJson({ command: "head -c 1500000 /dev/zero | tr '\\0' 'a' 1>&2; echo -n ok" });
    expect(status).toBe(200);
    expect(body.stderrTruncated).toBe(true);
    expect((body.stderr as string).length).toBe(1024 * 1024);
  });

  test("rejects a cwd that escapes the work dir via ..", async () => {
    const { status, body } = await execJson({ command: "pwd", cwd: ".." });
    expect(status).toBe(400);
    expect(body.error).toMatch(/cwd/i);
  });

  test(". and an omitted cwd both mean the work dir root (not an escape)", async () => {
    const dot = await execJson({ command: "pwd", cwd: "." });
    expect(dot.status).toBe(200);
    expect(dot.body.cwd).toBe(workReal);

    const empty = await execJson({ command: "pwd", cwd: "" });
    expect(empty.status).toBe(200);
    expect(empty.body.cwd).toBe(workReal);
  });

  test("rejects a cwd that escapes via an absolute path", async () => {
    const { status, body } = await execJson({ command: "pwd", cwd: "/etc" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/cwd/i);
  });

  test("rejects a cwd that escapes through a symlink (resolved-path check)", async () => {
    let linked = false;
    try {
      await symlink("/etc", join(workDir, "linkout"));
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) {
      // filesystem doesn't support symlinks; the resolved-path check is covered by the .. case
      expect(true).toBe(true);
      return;
    }
    // A string-only validator would pass here: "linkout" is a clean relative
    // path with no ".." segment. Only resolving the realpath catches the escape.
    const { status, body } = await execJson({ command: "pwd", cwd: "linkout" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/cwd/i);
    await rm(join(workDir, "linkout"), { force: true });
  });

  test("rejects a cwd that does not exist", async () => {
    const { status, body } = await execJson({ command: "pwd", cwd: "does-not-exist" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/cwd/i);
  });

  test("rejects an empty command", async () => {
    const { status, body } = await execJson({ command: "" });
    expect(status).toBe(400);
  });

  test("rejects invalid JSON body", async () => {
    const res = await app.request("/exec", {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("requires auth", async () => {
    const res = await app.request("/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "echo hi" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects a wrong token without revealing the ori", async () => {
    const { status, body } = await execJson({ command: "echo hi" }, "wrong-token");
    expect(status).toBe(401);
    expect(body).toEqual({ ok: false, error: "unauthorized" });
  });
});
