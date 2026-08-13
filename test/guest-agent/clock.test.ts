import { describe, expect, test } from "bun:test";
import { createGuestAgentApp } from "@ori/guest-agent/app";
import type { ClockRunner } from "@ori/guest-agent/clock";

const ORI_ID = "or_abcdef12";
const AGENT_TOKEN = "ori_at_secret_token";

// A fixed "guest clock" so the sanity window and steppedMs are deterministic.
const NOW = 1_700_000_000_000;

function makeApp(over: { now?: () => number; clockRunner?: ClockRunner } = {}) {
  return createGuestAgentApp({ oriId: ORI_ID, agentToken: AGENT_TOKEN, ...over });
}

function passingRunner(calls: string[][]): ClockRunner {
  return async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("T-P4-06 POST /clock", () => {
  test("requires auth", async () => {
    const res = await makeApp().request("/clock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ epochMs: NOW + 1000 }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects a wrong token without revealing the ori", async () => {
    const res = await makeApp().request("/clock", {
      method: "POST",
      headers: { authorization: `Bearer wrong-token`, "content-type": "application/json" },
      body: JSON.stringify({ epochMs: NOW + 1000 }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("a sane epoch steps the system clock via the fake runner and reports steppedMs", async () => {
    const calls: string[][] = [];
    const app = makeApp({ now: () => NOW, clockRunner: passingRunner(calls) });

    const res = await app.request("/clock", {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ epochMs: NOW + 5000 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, steppedMs: 5000 });
    expect(calls).toEqual([["date", "-s", "@1700000005"]]);
  });

  test("an insane epoch is rejected with 400 and never reaches the runner", async () => {
    const calls: string[][] = [];
    const app = makeApp({ now: () => NOW, clockRunner: passingRunner(calls) });

    const insane: unknown[] = [
      { epochMs: NOW - 11 * 365 * 24 * 60 * 60 * 1000 }, // > 10 years behind the guest clock
      { epochMs: NOW + 2 * 24 * 60 * 60 * 1000 }, // > 1 day ahead of the guest clock
      { epochMs: Number.NaN },
      { epochMs: -5 },
      { epochMs: "1.7e12" },
      { epochMs: undefined },
    ];
    for (const body of insane) {
      const res = await app.request("/clock", {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test("a failed date -s returns 500 with the reason", async () => {
    const app = makeApp({
      now: () => NOW,
      clockRunner: async () => ({ code: 1, stdout: "", stderr: "settimeofday: Operation not permitted" }),
    });
    const res = await app.request("/clock", {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ epochMs: NOW + 1000 }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/failed to set system clock/);
  });

  test("rejects invalid JSON body", async () => {
    const res = await makeApp().request("/clock", {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
