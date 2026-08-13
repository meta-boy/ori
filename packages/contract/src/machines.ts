export interface MachineSpec {
  key: MachineType;
  vcpu: number;
  memoryGB: number;
  diskGB: number;
  usableGB: number;
  billingMultiplier: number;
}

export const MACHINE_TYPES = ["nano", "small", "default", "large", "bare-metal"] as const;
export type MachineType = (typeof MACHINE_TYPES)[number];

/**
 * The ladder is sized for agent workloads on a self-hosted box, not for the machines the
 * published spec sells: a sandbox that runs a language model's shell commands needs a
 * fraction of a desktop VM, and the host running it is usually someone's spare hardware.
 * Every rung fits on a 16GB machine alongside the control plane, postgres and minio.
 *
 * These numbers are a DIVERGENCE from the published spec, which documented 4/8/16GB for
 * small/default/large. See docs/DIVERGENCES.md — a client that assumed `large` meant 16GB
 * gets 4GB here.
 */
export const MACHINE_TABLE: Record<MachineType, MachineSpec> = {
  nano: { key: "nano", vcpu: 1, memoryGB: 0.5, diskGB: 20, usableGB: 6, billingMultiplier: 0.25 },
  small: { key: "small", vcpu: 1, memoryGB: 1, diskGB: 20, usableGB: 8, billingMultiplier: 0.5 },
  default: { key: "default", vcpu: 2, memoryGB: 2, diskGB: 40, usableGB: 20, billingMultiplier: 1 },
  large: { key: "large", vcpu: 4, memoryGB: 4, diskGB: 60, usableGB: 36, billingMultiplier: 2 },
  "bare-metal": {
    key: "bare-metal",
    vcpu: 32,
    memoryGB: 128,
    diskGB: 2000,
    usableGB: 1400,
    billingMultiplier: 10,
  },
};

/**
 * Types a client may request via create/resume/fork. `bare-metal` is not requestable in v1.
 *
 * A tuple, not `readonly MachineType[]`, so the zod enum in schemas.ts can be built FROM it.
 * That mattered: the enum used to list the types a second time, and adding `nano` here left
 * the validator rejecting it — the API answered `invalid_json` to a type its own table
 * documented, and every unit test passed because none of them created one over HTTP.
 */
export const REQUESTABLE_TYPES = ["nano", "small", "default", "large"] as const satisfies readonly MachineType[];

export function isMachineType(v: unknown): v is MachineType {
  return typeof v === "string" && v in MACHINE_TABLE;
}

export function isRequestableType(v: unknown): v is (typeof REQUESTABLE_TYPES)[number] {
  return typeof v === "string" && (REQUESTABLE_TYPES as readonly string[]).includes(v);
}

export function machineFor(type: MachineType): MachineSpec {
  const spec = MACHINE_TABLE[type];
  if (!spec) throw new Error(`unknown machine type: ${String(type)}`);
  return spec;
}

export function usableBytes(type: MachineType): number {
  return machineFor(type).usableGB * 1024 * 1024 * 1024;
}

/** Given restored data bytes, is a target type large enough? */
export function fitsType(type: MachineType, contentSizeBytes: number): boolean {
  return contentSizeBytes <= usableBytes(type);
}

export function requestableTypeOrThrow(v: string): MachineType {
  if (!isRequestableType(v)) {
    throw new Error(`not a requestable machine type: ${v}`);
  }
  return v;
}
