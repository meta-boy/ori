export const ORI_STATES = [
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
] as const;

export type OriState = (typeof ORI_STATES)[number];

/** ssh/desktop/commands allowed. `running` = agent work in progress, still addressable. */
export const RUNNABLE: readonly OriState[] = ["ready", "idle"];

/** States whose machine-seconds are charged. */
export const BILLABLE: readonly OriState[] = [
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
];

/** BILLABLE equivalently — counts against maxActiveOris. */
export const ACTIVE: readonly OriState[] = BILLABLE;

/** Each create | fork | resume counts as one machine start for rate limits. */
export const STARTS = ["create", "fork", "resume"] as const;
export type StartKind = (typeof STARTS)[number];

/** Snapshot attempt statuses, from the OpenAPI Ori.lastSnapshotStatus enum. */
export const SNAPSHOT_STATUSES = [
  "queued",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export function isOriState(v: unknown): v is OriState {
  return typeof v === "string" && (ORI_STATES as readonly string[]).includes(v);
}

export function oriIn(v: readonly OriState[], candidate: string): boolean {
  return (v as readonly string[]).includes(candidate);
}

export function isRunnable(state: OriState): boolean {
  return (RUNNABLE as readonly OriState[]).includes(state);
}
export function isBillable(state: OriState): boolean {
  return (BILLABLE as readonly OriState[]).includes(state);
}
export function isActive(state: OriState): boolean {
  return (ACTIVE as readonly OriState[]).includes(state);
}
export function isStartKind(v: unknown): v is StartKind {
  return typeof v === "string" && (STARTS as readonly string[]).includes(v);
}