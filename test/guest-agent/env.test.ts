import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGuestAgentApp } from "@ori/guest-agent/app";
import { bashQuote, serializeEnv } from "@ori/guest-agent/env";

const ORI_ID = "or_abcdef12";
const AGENT_TOKEN = "ori_at_secret_token";

let workDir = "";
let envFile = "";
let app: ReturnType<typeof createGuestAgentApp>;

async function post(body: unknown, token = AGENT_TOKEN) {
  return app.request("/env", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postJson(body: unknown, token = AGENT_TOKEN) {
  const res = await post(body, token);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Source the env file in a real bash login shell and return var values as base64. */
async function sourceEnv(): Promise<Record<string, string>> {
  const keys = ["ORI_GA_FOO", "ORI_GA_NUM", "ORI_GA_NASTY", "ORI_GA_A", "ORI_GA_B", "ORI_GA_ATOMIC", "ORI_GA_MODE"];
  const script = [
    `set -a`,
    `source '${envFile}'`,
    `set +a`,
    `for k in ${keys.join(" ")}; do`,
    `  printf '%s=' "$k"`,
    `  printf '%s' "$(printenv "$k")" | base64`,
    `  echo`,
    `done`,
  ].join("\n");
  const proc = Bun.spawn({ cmd: ["bash", "-c", script], stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const result: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) result[line.slice(0, eq)] = Buffer.from(line.slice(eq + 1), "base64").toString("utf8");
  }
  return result;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ori-ga-"));
  await mkdir(join(workDir, "sub"), { recursive: true });
  envFile = join(workDir, "ori.env");
  process.env.ORI_WORK_DIR = workDir;
  process.env.ORI_ENV_FILE = envFile;
  app = createGuestAgentApp({ oriId: ORI_ID, agentToken: AGENT_TOKEN });
});

afterAll(async () => {
  delete process.env.ORI_WORK_DIR;
  delete process.env.ORI_ENV_FILE;
  await rm(workDir, { recursive: true, force: true });
});

describe("T-P4-04 /env", () => {
  test("writes env vars that a real bash source round-trips", async () => {
    const res = await postJson({ vars: { ORI_GA_FOO: "bar", ORI_GA_NUM: "42" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const sourced = await sourceEnv();
    expect(sourced.ORI_GA_FOO).toBe("bar");
    expect(sourced.ORI_GA_NUM).toBe("42");
  });

  test("nasty values round-trip exactly (newlines, quotes, backslash, $)", async () => {
    const nasty = "line1\nit's a \"quote\" \\ path $HOME and `cmd`\nlast";
    const res = await postJson({ vars: { ORI_GA_NASTY: nasty } });
    expect(res.status).toBe(200);
    const sourced = await sourceEnv();
    expect(sourced.ORI_GA_NASTY).toBe(nasty);
  });

  test("bashQuote escapes quotes without breaking the value", async () => {
    const v = `it's "quoted"`;
    expect(bashQuote(v)).toBe(`'it'\\''s "quoted"'`);
    expect(serializeEnv({ A: v })).toContain(bashQuote(v));
  });

  test("rejects invalid env names (name regex)", async () => {
    const { status, body } = await postJson({ vars: { "1BAD": "x" } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/env/i);
  });

  test("rejects more than 100 vars", async () => {
    const vars: Record<string, string> = {};
    for (let i = 0; i < 101; i++) vars[`VAR_${i}`] = "x";
    const { status, body } = await postJson({ vars });
    expect(status).toBe(400);
    expect(body.error).toMatch(/100|vars/i);
  });

  test("rejects env content over 64KB", async () => {
    const { status, body } = await postJson({ vars: { BIG: "x".repeat(64 * 1024) } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/64|env/i);
  });

  test("writes env file mode 0644", async () => {
    await postJson({ vars: { ORI_GA_MODE: "m" } });
    const st = await stat(envFile);
    expect(st.mode & 0o777).toBe(0o644);
  });

  test("atomic replace leaves no temp file behind", async () => {
    await postJson({ vars: { ORI_GA_ATOMIC: "1" } });
    const entries = await readdir(workDir);
    const temps = entries.filter((e) => e.includes(".tmp."));
    expect(temps).toHaveLength(0);
  });

  test("posting the same payload twice leaves identical bytes", async () => {
    const payload = { vars: { ORI_GA_A: "1", ORI_GA_B: "two" } };
    await postJson(payload);
    const first = await readFile(envFile);
    await postJson(payload);
    const second = await readFile(envFile);
    expect(second).toEqual(first);
  });

  test("writes secret files mode 0600 with parent dirs", async () => {
    const res = await postJson({
      files: [{ path: "a/b/c/service.json", contents: '{"k":"v"}' }],
    });
    expect(res.status).toBe(200);
    const st = await stat(join(workDir, "a", "b", "c", "service.json"));
    expect(st.mode & 0o777).toBe(0o600);
    expect(await readFile(join(workDir, "a", "b", "c", "service.json"), "utf8")).toBe('{"k":"v"}');
  });

  test("skips absolute and .. secret file paths without failing", async () => {
    const res = await postJson({
      files: [
        { path: "/etc/pwned", contents: "nope" },
        { path: "../escape.txt", contents: "nope" },
        { path: "ok.txt", contents: "fine" },
      ],
    });
    expect(res.status).toBe(200);
    expect(await readFile(join(workDir, "ok.txt"), "utf8")).toBe("fine");
    // nothing written outside the work dir
    const fs = await import("node:fs/promises");
    await expect(fs.stat("/etc/pwned")).rejects.toThrow();
    await expect(fs.stat(join(tmpdir(), "escape.txt"))).rejects.toThrow();
  });

  test("rejects a secret file symlink escape on write", async () => {
    let linked = false;
    try {
      await symlink("/etc/passwd", join(workDir, "evillink"));
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) {
      expect(true).toBe(true);
      return;
    }
    const { status } = await postJson({ files: [{ path: "evillink", contents: "pwned" }] });
    expect(status).toBe(400);
    const original = await readFile("/etc/passwd", "utf8");
    expect(original).not.toContain("pwned");
    await rm(join(workDir, "evillink"), { force: true });
  });

  test("rejects invalid JSON body", async () => {
    const res = await app.request("/env", {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("requires auth", async () => {
    const res = await app.request("/env", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vars: {} }),
    });
    expect(res.status).toBe(401);
  });
});
