import { describe, expect, test } from "bun:test";
import {
  MACHINE_TABLE,
  MACHINE_TYPES,
  REQUESTABLE_TYPES,
  isMachineType,
  isRequestableType,
  machineFor,
  usableBytes,
  fitsType,
  requestableTypeOrThrow,
} from "../src/machines";

describe("machine table", () => {
  // These numbers are OURS, not 's — the ladder was resized for agent sandboxes on
  // self-hosted hardware (docs/DIVERGENCES.md). The test still pins them exactly, because the
  // sizes are a contract with every client that asks for a type by name.
  test("documents the four public types with exact specs", () => {
    expect(MACHINE_TABLE.nano).toEqual({
      key: "nano",
      vcpu: 1,
      memoryGB: 0.5,
      diskGB: 20,
      usableGB: 6,
      billingMultiplier: 0.25,
    });
    expect(MACHINE_TABLE.small).toEqual({
      key: "small",
      vcpu: 1,
      memoryGB: 1,
      diskGB: 20,
      usableGB: 8,
      billingMultiplier: 0.5,
    });
    expect(MACHINE_TABLE.default).toEqual({
      key: "default",
      vcpu: 2,
      memoryGB: 2,
      diskGB: 40,
      usableGB: 20,
      billingMultiplier: 1,
    });
    expect(MACHINE_TABLE.large).toEqual({
      key: "large",
      vcpu: 4,
      memoryGB: 4,
      diskGB: 60,
      usableGB: 36,
      billingMultiplier: 2,
    });
  });

  test("the ladder only ever goes up — a bigger type is bigger in every dimension", () => {
    // Resume and fork let a caller move between types, and fitsType() compares usable disk.
    // A ladder that is not monotonic would make "upgrade" mean "smaller disk" for some pair.
    const ladder = ["nano", "small", "default", "large"] as const;
    for (let i = 1; i < ladder.length; i++) {
      const prev = MACHINE_TABLE[ladder[i - 1]!];
      const next = MACHINE_TABLE[ladder[i]!];
      expect(next.vcpu).toBeGreaterThanOrEqual(prev.vcpu);
      expect(next.memoryGB).toBeGreaterThanOrEqual(prev.memoryGB);
      expect(next.usableGB).toBeGreaterThan(prev.usableGB);
      expect(next.billingMultiplier).toBeGreaterThan(prev.billingMultiplier);
    }
  });

  test("every rung fits beside the control plane on a 16GB host", () => {
    // The reason the table was resized. postgres + minio + the control plane want a few GB;
    // a type that cannot coexist with them on the smallest realistic host is a trap.
    for (const t of REQUESTABLE_TYPES) expect(MACHINE_TABLE[t].memoryGB).toBeLessThanOrEqual(4);
  });

  test("billing multipliers stay proportional to the machine", () => {
    expect(MACHINE_TABLE.nano.billingMultiplier).toBe(0.25);
    expect(MACHINE_TABLE.small.billingMultiplier).toBe(0.5);
    expect(MACHINE_TABLE.default.billingMultiplier).toBe(1);
    expect(MACHINE_TABLE.large.billingMultiplier).toBe(2);
  });

  test("every type has a matching spec and positive usable disk", () => {
    for (const t of MACHINE_TYPES) {
      expect(machineFor(t)).toBe(MACHINE_TABLE[t]);
      expect(MACHINE_TABLE[t].usableGB).toBeGreaterThan(0);
      expect(MACHINE_TABLE[t].diskGB).toBeGreaterThan(MACHINE_TABLE[t].usableGB);
    }
  });

  test("usable disk is a slice of total disk, never all of it", () => {
    expect(MACHINE_TABLE.nano.usableGB).toBe(6);
    expect(MACHINE_TABLE.small.usableGB).toBe(8);
    expect(MACHINE_TABLE.default.usableGB).toBe(20);
    expect(MACHINE_TABLE.large.usableGB).toBe(36);
  });
});

describe("requestable types", () => {
  test("clients may request nano/small/default/large (bare-metal is not v1)", () => {
    expect(REQUESTABLE_TYPES).toEqual(["nano", "small", "default", "large"]);
  });

  test("bare-metal is a known type but not requestable", () => {
    expect(isMachineType("bare-metal")).toBe(true);
    expect(isRequestableType("bare-metal")).toBe(false);
  });

  test("predicates", () => {
    expect(isMachineType("small")).toBe(true);
    expect(isMachineType("big")).toBe(false);
    expect(isRequestableType("default")).toBe(true);
    expect(isRequestableType("huge")).toBe(false);
  });

  test("requestableTypeOrThrow", () => {
    expect(requestableTypeOrThrow("large")).toBe("large");
    expect(() => requestableTypeOrThrow("bare-metal")).toThrow();
    expect(() => requestableTypeOrThrow("wat")).toThrow();
  });
});

describe("capacity math", () => {
  test("usableBytes converts GB to bytes", () => {
    expect(usableBytes("default")).toBe(20 * 1024 * 1024 * 1024);
    expect(usableBytes("small")).toBe(8 * 1024 * 1024 * 1024);
  });

  test("fitsType rejects over-capacity data (type_too_small)", () => {
    expect(fitsType("large", usableBytes("large"))).toBe(true);
    expect(fitsType("large", usableBytes("large") - 1)).toBe(true);
    // default data (20GB) must NOT fit into small (8GB)
    expect(fitsType("small", usableBytes("default"))).toBe(false);
    expect(fitsType("default", usableBytes("large"))).toBe(false);
  });

  test("boundary: exactly usable fits, +1 does not", () => {
    expect(fitsType("small", usableBytes("small"))).toBe(true);
    expect(fitsType("small", usableBytes("small") + 1)).toBe(false);
  });
});