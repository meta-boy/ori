import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGuestAgentApp } from "@ori/guest-agent/app";

const ORI_ID = "or_abcdef12";
const AGENT_TOKEN = "ori_at_secret_token";

let workDir = "";
let app: ReturnType<typeof createGuestAgentApp>;

async function get(path: string, encoding?: string, token = AGENT_TOKEN) {
  const qs = new URLSearchParams({ path });
  if (encoding) qs.set("encoding", encoding);
  return app.request(`/file?${qs}`, { headers: { authorization: `Bearer ${token}` } });
}

async function put(body: unknown, token = AGENT_TOKEN) {
  return app.request("/file", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function putJson(body: unknown, token = AGENT_TOKEN) {
  const res = await put(body, token);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getJson(path: string, encoding?: string, token = AGENT_TOKEN) {
  const res = await get(path, encoding, token);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ori-ga-"));
  await mkdir(join(workDir, "sub"), { recursive: true });
  process.env.ORI_WORK_DIR = workDir;
  app = createGuestAgentApp({ oriId: ORI_ID, agentToken: AGENT_TOKEN });
});

afterAll(async () => {
  delete process.env.ORI_WORK_DIR;
  await rm(workDir, { recursive: true, force: true });
});

describe("T-P4-03 PUT /file", () => {
  test("utf8 round-trip", async () => {
    const putRes = await putJson({ path: "hello.txt", content: "hello world", encoding: "utf8" });
    expect(putRes.status).toBe(200);
    expect(putRes.body).toMatchObject({ ok: true, path: "hello.txt", encoding: "utf8", size: 11 });

    const getRes = await getJson("hello.txt", "utf8");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toMatchObject({ ok: true, path: "hello.txt", encoding: "utf8", size: 11 });
    expect(getRes.body.content).toBe("hello world");
  });

  test("base64 binary round-trip is byte-for-byte", async () => {
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 128]);
    const b64 = bytes.toString("base64");
    const putRes = await putJson({ path: "bin.dat", content: b64, encoding: "base64" });
    expect(putRes.status).toBe(200);
    expect(putRes.body.size).toBe(bytes.length);

    const getRes = await getJson("bin.dat", "base64");
    expect(getRes.status).toBe(200);
    expect(getRes.body.content).toBe(b64);
    expect(Buffer.from(getRes.body.content as string, "base64")).toEqual(bytes);
  });

  test("creates missing parent directories", async () => {
    const putRes = await putJson({ path: "a/b/c/deep.txt", content: "deep", encoding: "utf8" });
    expect(putRes.status).toBe(200);
    const st = await stat(join(workDir, "a", "b", "c", "deep.txt"));
    expect(st.isFile()).toBe(true);
  });

  test("writes files with mode 0600", async () => {
    await putJson({ path: "mode.txt", content: "x", encoding: "utf8" });
    const st = await stat(join(workDir, "mode.txt"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("defaults encoding to utf8", async () => {
    const putRes = await putJson({ path: "default.txt", content: "plain" });
    expect(putRes.status).toBe(200);
    expect(putRes.body.encoding).toBe("utf8");
  });

  test("rejects an absolute path", async () => {
    const { status, body } = await putJson({ path: "/etc/passwd", content: "x" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/path/i);
  });

  test("rejects a path with ..", async () => {
    const { status, body } = await putJson({ path: "../escape.txt", content: "x" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/path/i);
  });

  test("rejects a symlink escape on PUT (link -> /etc/passwd)", async () => {
    let linked = false;
    try {
      await symlink("/etc/passwd", join(workDir, "evil"));
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) {
      expect(true).toBe(true);
      return;
    }
    const { status, body } = await putJson({ path: "evil", content: "pwned" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/path/i);
    // the target must be untouched
    const original = await readFile("/etc/passwd", "utf8");
    expect(original).not.toContain("pwned");
    await rm(join(workDir, "evil"), { force: true });
  });

  test("rejects content over the 10MB cap", async () => {
    const { status, body } = await putJson({ path: "big.txt", content: "a".repeat(10 * 1024 * 1024 + 1) });
    expect(status).toBe(400);
    expect(body.error).toMatch(/exceeds/i);
  });

  test("rejects invalid base64", async () => {
    const { status } = await putJson({ path: "bad64.txt", content: "!!!not-base64!!!", encoding: "base64" });
    expect(status).toBe(400);
  });
});

describe("T-P4-03 GET /file", () => {
  test("missing file returns 404 not_found", async () => {
    const { status, body } = await getJson("nope.txt");
    expect(status).toBe(404);
    expect(body.error).toMatch(/not_found|no such|cannot/i);
  });

  test("GET on a directory returns 400, not a stack trace", async () => {
    const { status, body } = await getJson("sub");
    expect(status).toBe(400);
    expect(body.error).toMatch(/directory/i);
  });

  test("utf8 read of binary is rejected, not silently corrupted", async () => {
    await putJson({ path: "bin2.dat", content: Buffer.from([0xff, 0xfe, 0x41]).toString("base64"), encoding: "base64" });
    const { status, body } = await getJson("bin2.dat", "utf8");
    expect(status).toBe(400);
    expect(body.error).toMatch(/utf8/i);
  });

  test("rejects a file over the 10MB cap on read", async () => {
    const big = "b".repeat(10 * 1024 * 1024 + 5);
    await writeFile(join(workDir, "bigfile.txt"), big);
    const { status, body } = await getJson("bigfile.txt", "utf8");
    expect(status).toBe(400);
    expect(body.error).toMatch(/exceeds/i);
  });

  test("rejects an absolute path on read", async () => {
    const { status } = await getJson("/etc/hosts");
    expect(status).toBe(400);
  });

  test("rejects a path with .. on read", async () => {
    const { status } = await getJson("../secret");
    expect(status).toBe(400);
  });
});

describe("T-P4-03 /file auth", () => {
  test("requires auth for GET and PUT", async () => {
    const noAuthGet = await app.request(`/file?path=hello.txt`, { headers: { authorization: "" } });
    expect(noAuthGet.status).toBe(401);
    const noAuthPut = await app.request("/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "x.txt", content: "y" }),
    });
    expect(noAuthPut.status).toBe(401);
  });

  test("rejects a wrong token", async () => {
    const res = await get("hello.txt", "utf8", "wrong");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });
});
