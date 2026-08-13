import { describe, expect, test } from "bun:test";
import { createGuestAgentApp, defaultDiskUsedBytes } from "@ori/guest-agent/app";
import { sha256Hex, timingSafeEqualHex } from "@ori/contract";

const ORI_ID = "or_abcdef12";
const AGENT_TOKEN = "ori_at_secret_token";

function makeApp(over: Partial<Parameters<typeof createGuestAgentApp>[0]> = {}) {
  return createGuestAgentApp({
    oriId: ORI_ID,
    agentToken: AGENT_TOKEN,
    now: () => 1_000_000,
    diskUsedBytes: async () => 4096,
    ...over,
  });
}

async function get(app: ReturnType<typeof createGuestAgentApp>, token: string | null) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.request("/health", { headers });
}

describe("T-P4-01 GET /health auth", () => {
  test("accepts the correct agent token", async () => {
    const app = makeApp();
    const res = await get(app, AGENT_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, oriId: ORI_ID, uptimeSeconds: 0, diskUsedBytes: 4096 });
  });

  test("rejects a wrong token with 401", async () => {
    const app = makeApp();
    const res = await get(app, "ori_at_wrong_token");
    expect(res.status).toBe(401);
  });

  test("rejects a missing token with 401", async () => {
    const app = makeApp();
    const res = await get(app, null);
    expect(res.status).toBe(401);
  });

  test("wrong-token responses never reveal whether the ori exists", async () => {
    const existing = makeApp({ oriId: "or_aaaaaaaa" });
    const missing = makeApp({ oriId: "or_bbbbbbbb" });

    const resExisting = await get(existing, "wrong");
    const resMissing = await get(missing, "wrong");
    const bodyExisting = await resExisting.json();
    const bodyMissing = await resMissing.json();

    // Identical status and body for an existing vs. non-existent ori: an
    // unauthenticated client cannot probe which ori ids are live.
    expect(resExisting.status).toBe(401);
    expect(resMissing.status).toBe(401);
    expect(bodyExisting).toEqual(bodyMissing);
    expect(bodyExisting).toEqual({ ok: false, error: "unauthorized" });
    expect(JSON.stringify(bodyExisting)).not.toContain("or_");
  });
});

describe("T-P4-01 GET /health shape", () => {
  test("returns ok, oriId, uptimeSeconds and diskUsedBytes", async () => {
    const app = makeApp();
    const res = await get(app, AGENT_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.oriId).toBe(ORI_ID);
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof body.diskUsedBytes).toBe("number");
  });

  test("uptimeSeconds grows with the injected clock", async () => {
    let clock = 1_000_000;
    const app = makeApp({ now: () => clock });
    clock = 1_000_000 + 7500;
    const body = await (await get(app, AGENT_TOKEN)).json();
    expect(body.uptimeSeconds).toBe(7);
  });

  test("defaultDiskUsedBytes is a non-negative number", async () => {
    const bytes = await defaultDiskUsedBytes("/");
    expect(typeof bytes).toBe("number");
    expect(bytes).toBeGreaterThanOrEqual(0);
  });
});

describe("T-P4-01 structured logging", () => {
  test("logs one JSON line per request without the token", async () => {
    const lines: Record<string, unknown>[] = [];
    const app = makeApp({ onLog: (l) => lines.push(l) });
    await get(app, AGENT_TOKEN);
    await get(app, "wrong-token");

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.method).toBe("GET");
      expect(line.path).toBe("/health");
      expect(typeof line.status).toBe("number");
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain(AGENT_TOKEN);
      expect(serialized).not.toContain("ori_at_");
    }
  });
});

describe("T-P4-01 crypto helpers", () => {
  test("timingSafeEqualHex matches only identical hex", () => {
    const a = sha256Hex("alpha");
    const b = sha256Hex("beta");
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, b)).toBe(false);
    expect(timingSafeEqualHex("abc", "abcd")).toBe(false); // differing length
  });
});
