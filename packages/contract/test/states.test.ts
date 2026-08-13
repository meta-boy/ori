import { describe, expect, test } from "bun:test";
import {
  ORI_STATES,
  RUNNABLE,
  BILLABLE,
  ACTIVE,
  STARTS,
  SNAPSHOT_STATUSES,
  isOriState,
  isRunnable,
  isBillable,
  isActive,
  isStartKind,
  oriIn,
  type OriState,
} from "../src/states";

describe("state set", () => {
  test("contains the documented 10 ori states exactly", () => {
    expect(ORI_STATES).toEqual([
      "init",
      "provisioning",
      "provisioned",
      "cloning",
      "ready",
      "idle",
      "running",
      "archiving",
      "archived",
      "error",
    ]);
  });

  test("states are unique", () => {
    expect(new Set(ORI_STATES).size).toBe(ORI_STATES.length);
  });
});

describe("RUNNABLE", () => {
  test("is ready | idle", () => {
    expect(RUNNABLE).toEqual(["ready", "idle"]);
  });
});

describe("BILLABLE vs ACTIVE", () => {
  test("ACTIVE is identical to BILLABLE", () => {
    expect(ACTIVE).toEqual(BILLABLE);
  });

  test("BILLABLE covers everything except init/archived/error", () => {
    const nonBillable = ORI_STATES.filter(
      (s) => !(BILLABLE as readonly OriState[]).includes(s),
    );
    expect(nonBillable.slice().sort()).toEqual(["archived", "error", "init"]);
  });

  test("running is billable (work in progress, not 'VM down')", () => {
    expect(BILLABLE).toContain("running");
  });
});

describe("STARTS", () => {
  test("create | fork | resume each count as a machine start", () => {
    expect(STARTS).toEqual(["create", "fork", "resume"]);
  });
});

describe("status helpers", () => {
  test("isOriState", () => {
    for (const s of ORI_STATES) expect(isOriState(s)).toBe(true);
    expect(isOriState("recycled")).toBe(false);
    expect(isOriState(12)).toBe(false);
    expect(isOriState(undefined)).toBe(false);
  });

  test("isRunnable", () => {
    expect(isRunnable("ready")).toBe(true);
    expect(isRunnable("idle")).toBe(true);
    expect(isRunnable("running")).toBe(false);
    expect(isRunnable("archived")).toBe(false);
    expect(isRunnable("provisioning")).toBe(false);
  });

  test("isBillable", () => {
    for (const s of BILLABLE) expect(isBillable(s)).toBe(true);
    expect(isBillable("archived")).toBe(false);
    expect(isBillable("init")).toBe(false);
  });

  test("isActive mirrors billable", () => {
    for (const s of ORI_STATES) {
      expect(isActive(s)).toBe(isBillable(s));
    }
  });

  test("isStartKind", () => {
    expect(isStartKind("create")).toBe(true);
    expect(isStartKind("resume")).toBe(true);
    expect(isStartKind("stop")).toBe(false);
    expect(isStartKind(undefined)).toBe(false);
  });

  test("oriIn membership helper", () => {
    expect(oriIn(RUNNABLE, "ready")).toBe(true);
    expect(oriIn(RUNNABLE, "archived")).toBe(false);
  });
});

describe("snapshot statuses", () => {
  test("pinned enum (from Ori.lastSnapshotStatus)", () => {
    expect(SNAPSHOT_STATUSES).toEqual([
      "queued",
      "in_progress",
      "completed",
      "failed",
      "cancelled",
    ]);
  });
});