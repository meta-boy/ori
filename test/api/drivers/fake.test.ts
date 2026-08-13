import { describe, expect, test, afterAll } from "bun:test";
import { FakeMachineDriver, FakeGuestAgent } from "@ori/api/drivers/fake";
import type { MachineDriver } from "@ori/api/drivers/types";
import { oriId, snapshotId } from "@ori/contract";
import { sha256Hex, timingSafeEqualHex } from "@ori/api/middleware/auth";

function makeInput(over: Partial<Parameters<MachineDriver["create"]>[0]> = {}) {
  return {
    oriId: oriId(),
    type: "default" as const,
    image: "ubuntu-24.04",
    machineToken: "ori_mt_test",
    agentToken: "ori_at_test",
    ...over,
  };
}

describe("T-P3-01 MachineDriver interface shape", () => {
  test("has exactly the four §5 methods (structural check)", () => {
    const driver: MachineDriver = new FakeMachineDriver();
    const methods = ["create", "destroy", "ip", "isAlive"];
    for (const m of methods) expect(typeof (driver as any)[m]).toBe("function");
    // The interface is exactly {create,destroy,ip,isAlive}; a FakeMachineDriver
    // assigned to it must expose at least those. Compile-time structural typing
    // forbids omitting any of them, and extras are concrete-only accessors.
    const ifaceKeys = Object.keys({
      create: driver.create,
      destroy: driver.destroy,
      ip: driver.ip,
      isAlive: driver.isAlive,
    });
    expect(ifaceKeys.sort()).toEqual(methods.sort());
  });
});

describe("T-P3-01 FakeMachineDriver lifecycle", () => {
  const driver = new FakeMachineDriver();

  afterAll(async () => {
    await driver.stopAll();
  });

  test("create returns a machineId and a fake loopback ip", async () => {
    const { machineId, ip } = await driver.create(makeInput());
    expect(machineId).toMatch(/^m_\d+$/);
    expect(ip).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(await driver.isAlive(machineId)).toBe(true);
    expect(await driver.ip(machineId)).toBe(ip);
  });

  test("each machine gets a distinct ip", async () => {
    const a = await driver.create(makeInput());
    const b = await driver.create(makeInput());
    expect(a.ip).not.toBe(b.ip);
    expect(await driver.isAlive(a.machineId)).toBe(true);
    expect(await driver.isAlive(b.machineId)).toBe(true);
  });

  test("ip/isAlive return null/false for unknown machines", async () => {
    expect(await driver.ip("m_nope")).toBeNull();
    expect(await driver.isAlive("m_nope")).toBe(false);
  });

  test("destroy removes the machine; ip and isAlive reflect it", async () => {
    const { machineId } = await driver.create(makeInput());
    await driver.destroy(machineId);
    expect(await driver.isAlive(machineId)).toBe(false);
    expect(await driver.ip(machineId)).toBeNull();
  });

  test("destroy of an unknown machine is a no-op", async () => {
    await expect(driver.destroy("m_nope")).resolves.toBeUndefined();
  });

  test("injectable create failure throws and leaves no machine", async () => {
    const d = new FakeMachineDriver();
    d.failNextCreate = true;
    await expect(d.create(makeInput())).rejects.toThrow("injected create failure");
    expect(d.liveCount).toBe(0);
    await d.stopAll();
  });

  test("injectable destroy failure keeps the machine alive", async () => {
    const d = new FakeMachineDriver();
    const { machineId } = await d.create(makeInput());
    d.failNextDestroy = true;
    await expect(d.destroy(machineId)).rejects.toThrow("injected destroy failure");
    expect(await d.isAlive(machineId)).toBe(true);
    await d.stopAll();
  });
});

describe("T-P3-01 FakeGuestAgent §5 API", () => {
  const agentToken = "ori_at_guest_test";
  const guest = new FakeGuestAgent(oriId(), agentToken);
  const tokenHash = sha256Hex(agentToken);

  test("verifyToken accepts the real token and rejects everything else", () => {
    expect(guest.verifyToken(agentToken)).toBe(true);
    expect(guest.verifyToken("ori_at_wrong")).toBe(false);
    expect(guest.verifyToken(null)).toBe(false);
    expect(guest.verifyToken("")).toBe(false);
  });

  test("token verification uses timing-safe comparison", () => {
    expect(timingSafeEqualHex(sha256Hex(agentToken), tokenHash)).toBe(true);
    expect(timingSafeEqualHex(sha256Hex("ori_at_wrong"), tokenHash)).toBe(false);
  });

  test("GET /health answers with oriId, uptimeSeconds and diskUsedBytes", async () => {
    const res = await guest.handle(new Request("http://localhost/health", { headers: { authorization: `Bearer ${agentToken}` } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.oriId).toBe(guest.oriId);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.diskUsedBytes).toBeGreaterThanOrEqual(0);
  });

  test("/health fails closed when failHealth is set", async () => {
    guest.failHealth = true;
    const res = await guest.handle(new Request("http://localhost/health", { headers: { authorization: `Bearer ${agentToken}` } }));
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
    guest.failHealth = false;
  });

  test("every endpoint rejects a missing or wrong bearer token", async () => {
    for (const [method, path, body] of [
      ["GET", "/health", null],
      ["POST", "/exec", { command: "ls" }],
      ["GET", "/file?path=a.txt", null],
      ["PUT", "/file", { path: "a.txt", content: "x" }],
      ["POST", "/sshkey", { key: "ssh-ed25519 AAA" }],
      ["POST", "/snapshot", { mode: "final" }],
      ["POST", "/restore", { snapshotRef: "x", scrubEnv: false }],
      ["POST", "/env", { vars: {}, files: [] }],
      ["POST", "/prompt", { prompt: "hi" }],
      ["POST", "/interrupt", {}],
      ["GET", "/desktop/start", null],
      ["POST", "/host", { port: 8080 }],
    ] as const) {
      const res = await guest.handle(
        new Request(`http://localhost${path}`, { method, headers: { authorization: "Bearer nope" }, body: body ? JSON.stringify(body) : undefined }),
      );
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  test("POST /exec returns the CommandResponse shape", async () => {
    const res = await guest.handle(
      new Request("http://localhost/exec", {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ command: "uname -a", cwd: ".", timeoutSeconds: 30 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("command.finished");
    expect(body.success).toBe(true);
    expect(typeof body.exitCode).toBe("number");
    expect(typeof body.stdout).toBe("string");
    expect(typeof body.timedOut).toBe("boolean");
    expect(body.cwd).toBe(".");
    expect(body.startedAt).toBeDefined();
    expect(body.finishedAt).toBeDefined();
  });

  test("PUT then GET /file round-trips utf8 content", async () => {
    const put = await guest.handle(
      new Request("http://localhost/file", {
        method: "PUT",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ path: "hello.txt", content: "hello world", encoding: "utf8" }),
      }),
    );
    expect(put.status).toBe(200);

    const got = await guest.handle(
      new Request("http://localhost/file?path=hello.txt&encoding=utf8", { headers: { authorization: `Bearer ${agentToken}` } }),
    );
    expect(got.status).toBe(200);
    const body = await got.json();
    expect(body.type).toBe("file.read");
    expect(body.content).toBe("hello world");
    expect(body.size).toBe(11);
  });

  test("GET /file for a missing path returns 404", async () => {
    const res = await guest.handle(
      new Request("http://localhost/file?path=missing.txt", { headers: { authorization: `Bearer ${agentToken}` } }),
    );
    expect(res.status).toBe(404);
  });

  test("POST /sshkey records the key", async () => {
    await guest.handle(
      new Request("http://localhost/sshkey", {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA" }),
      }),
    );
    expect(guest.authorizedKeys).toContain("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA");
  });

  test("POST /snapshot returns a uuid, generation and counts; increments generation", async () => {
    const r1 = await guest.handle(
      new Request("http://localhost/snapshot", {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "final" }),
      }),
    );
    const s1 = await r1.json();
    expect(r1.status).toBe(200);
    expect(s1.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s1.generation).toBe(1);
    expect(s1.sizeBytes).toBeGreaterThan(0);
    expect(s1.fileCount).toBeGreaterThan(0);

    const r2 = await guest.handle(
      new Request("http://localhost/snapshot", {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "auto" }),
      }),
    );
    const s2 = await r2.json();
    expect(s2.generation).toBe(2);
  });

  test("snapshot failure is injectable and surfaces as a 500", async () => {
    guest.failSnapshot = true;
    const res = await guest.handle(
      new Request("http://localhost/snapshot", {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "final" }),
      }),
    );
    expect(res.status).toBe(500);
    guest.failSnapshot = false;
  });

  test("POST /restore records snapshotRef and scrubEnv", async () => {
    const res = await guest.handle(
      new Request("http://localhost/restore", {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ snapshotRef: snapshotId(), scrubEnv: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(guest.lastRestore?.scrubEnv).toBe(true);
    expect(guest.lastRestore?.snapshotRef).toBeDefined();
  });

  test("POST /env records vars and secret files", async () => {
    await guest.handle(
      new Request("http://localhost/env", {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ vars: { FOO: "bar" }, files: [{ path: ".secret", contents: "hunter2" }] }),
      }),
    );
    expect(guest.envVars.get("FOO")).toBe("bar");
    expect(guest.secretFiles.get(".secret")).toBe("hunter2");
  });

  test("POST /prompt, /interrupt, /host and /desktop are recorded", async () => {
    await guest.handle(
      new Request("http://localhost/prompt", {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ runId: "r1", provider: "codex", model: "gpt-5.4", prompt: "do the thing" }),
      }),
    );
    expect(guest.lastPrompt?.runId).toBe("r1");
    expect(guest.lastPrompt?.provider).toBe("codex");

    await guest.handle(
      new Request("http://localhost/interrupt", { method: "POST", headers: { authorization: `Bearer ${agentToken}` } }),
    );
    expect(guest.interruptCalls).toBe(1);

    await guest.handle(
      new Request("http://localhost/desktop/start", { headers: { authorization: `Bearer ${agentToken}` } }),
    );
    expect(guest.desktopStarted).toBe(true);

    await guest.handle(
      new Request("http://localhost/host", {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ port: 8080, title: "web", public: true }),
      }),
    );
    expect(guest.hostCalls).toContainEqual({ port: 8080, title: "web", public: true });
  });

  test("unknown routes return 404", async () => {
    const res = await guest.handle(
      new Request("http://localhost/nope", { headers: { authorization: `Bearer ${agentToken}` } }),
    );
    expect(res.status).toBe(404);
  });
});

describe("T-P3-01 driver + guest agent over real HTTP", () => {
  const driver = new FakeMachineDriver();

  afterAll(async () => {
    await driver.stopAll();
  });

  test("control plane can reach the guest agent through the machine ip", async () => {
    const { machineId, ip } = await driver.create(makeInput({ agentToken: "ori_at_http_test" }));
    const res = await fetch(`http://${ip}/health`, {
      headers: { authorization: "Bearer ori_at_http_test" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(await driver.isAlive(machineId)).toBe(true);
  });
});
