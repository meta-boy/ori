import { describe, expect, test } from "bun:test";
import { ORI_STATES, type OriState } from "../src/states";
import {
  ORI_ACTIONS,
  TRANSITION_TABLE,
  applyAction,
  type OriAction,
} from "../src/transitions";

const ALL_STATES = ORI_STATES;

describe("state machine (every (state, action) pair)", () => {
  test("covers every state for every action — no wildcard outcomes", () => {
    // every pair resolves deterministically to ok or a documented error code
    for (const state of ALL_STATES) {
      for (const action of ORI_ACTIONS) {
        const r = applyAction(action, state);
        if (r.ok) {
          expect(ORI_STATES).toContain(r.to);
        } else {
          expect(typeof r.code).toBe("string");
          expect(r.code.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("each action's allowed list is a subset of declared states", () => {
    for (const action of ORI_ACTIONS) {
      for (const s of TRANSITION_TABLE[action].allowed) {
        expect(ORI_STATES).toContain(s);
      }
    }
  });

  test("run-to-ready requires an explicit transition; ready/idle are the runnable window", () => {
    // provisioning is NOT directly runnable — a ori must be provisioned then ready/idle
    expect(applyAction("command", "provisioning").ok).toBe(false);
    expect(applyAction("command", "ready").ok).toBe(true);
    expect(applyAction("command", "idle").ok).toBe(true);
  });

  test("interrupt only from running", () => {
    expect(applyAction("interrupt", "running")).toEqual({ ok: true, to: "idle" });
    expect(applyAction("interrupt", "idle").ok).toBe(false);
    expect(applyAction("interrupt", "archived").ok).toBe(false);
  });

  test("stop is legal from every live billable state", () => {
    for (const s of ["ready", "idle", "running", "provisioning", "provisioned", "cloning"] as OriState[]) {
      expect(applyAction("stop", s)).toEqual({ ok: true, to: "archiving" });
    }
    // cannot stop an already-archived or dead ori
    expect(applyAction("stop", "archived").ok).toBe(false);
    expect(applyAction("stop", "error").ok).toBe(false);
  });

  test("resume is only legal from archived", () => {
    for (const s of ALL_STATES) {
      const r = applyAction("resume", s);
      expect(r.ok).toBe(s === "archived");
      if (s === "archived") expect(r).toEqual({ ok: true, to: "provisioning" });
      else expect(!r.ok && r.code === "resume_failed").toBe(true);
    }
  });

  test("fork is legal from active and archived sources", () => {
    for (const s of ALL_STATES) {
      const r = applyAction("fork", s);
      expect(r.ok ? r.to : r).toBeDefined();
      if ((TRANSITION_TABLE.fork.allowed as OriState[]).includes(s)) {
        expect(r).toEqual({ ok: true, to: "cloning" });
      } else {
        expect(r.ok).toBe(false);
      }
    }
  });

  test("prompt transitions a runnable ori to running for work", () => {
    for (const s of ["ready", "idle", "running"] as OriState[]) {
      expect(applyAction("prompt", s)).toEqual({ ok: true, to: "running" });
    }
    expect(applyAction("prompt", "archived").ok).toBe(false);
    expect(applyAction("prompt", "provisioning").ok).toBe(false);
  });
});

describe("machine_not_running boundary (§4 RUNNABLE = ready|idle)", () => {
  test("ssh/desktop/commands/files are gated to ready|idle", () => {
    for (const action of ["command", "files", "sshkey", "desktop"] as OriAction[]) {
      expect(applyAction(action, "ready").ok).toBe(true);
      expect(applyAction(action, "idle").ok).toBe(true);
      expect(applyAction(action, "running").ok).toBe(false);
      expect(applyAction(action, "error").ok).toBe(false);
      expect(applyAction(action, "archiving").ok).toBe(false);
    }
  });

  test("disallowed interactive actions return machine_not_running", () => {
    for (const action of ["command", "files", "sshkey", "desktop"] as OriAction[]) {
      const r = applyAction(action, "archived");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("machine_not_running");
    }
  });

  test("ori_not_promptable gates prompting and interrupt", () => {
    const r1 = applyAction("prompt", "init");
    const r2 = applyAction("interrupt", "ready");
    expect(!r1.ok && r1.code === "ori_not_promptable").toBe(true);
    expect(!r2.ok && r2.code === "ori_not_promptable").toBe(true);
  });
});