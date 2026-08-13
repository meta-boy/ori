import type { Ori } from "@/lib/api";
import { apiGet } from "@/lib/api";

/** States where the TTL clock is still counting toward an auto-stop. */
export const TICKING = ["init", "provisioning", "provisioned", "cloning", "ready", "idle", "running"];
export const RUNNABLE = ["ready", "idle"];
export const STOPPABLE = ["ready", "idle", "running", "provisioning", "provisioned", "cloning"];
export const ORI_STATES = [
  "init", "provisioning", "provisioned", "cloning", "ready", "idle", "running", "archiving", "archived", "error",
] as const;

/**
 * The states the server can put a sandbox in. Derived from the list above rather than imported
 * from @ori/contract, because this package deliberately does not depend on it — but derived, so
 * an optimistic state the server can never produce is a compile error rather than a row that
 * shows a word no other code recognises.
 */
export type OriState = (typeof ORI_STATES)[number];

/**
 * Mirrors MACHINE_TABLE in @ori/contract. Duplicated on purpose — this package does not depend
 * on the contract (see the note above) — so it has to be changed in both places; the server is
 * the authority and will reject a type this list invents.
 */
export const TYPES = [
  { key: "nano", name: "Nano", vcpu: 1, ram: 0.5, disk: 20 },
  { key: "small", name: "Small", vcpu: 1, ram: 1, disk: 20 },
  { key: "default", name: "Default", vcpu: 2, ram: 2, disk: 40 },
  { key: "large", name: "Large", vcpu: 4, ram: 4, disk: 60 },
];

export const TTL_OPTIONS: Array<[string, string]> = [
  ["3600", "1 hour"],
  ["10800", "3 hours"],
  ["21600", "6 hours"],
  ["43200", "12 hours"],
  ["86400", "1 day"],
  ["604800", "1 week"],
  ["2592000", "30 days"],
  ["never", "Never (no auto-stop)"],
];

/** Follow the cursor to the end; the dashboard shows every ori, not the first page. */
export async function fetchAllOris(): Promise<Ori[]> {
  let cursor: string | null = null;
  const all: Ori[] = [];
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ limit: "200", sort: "desc" });
    if (cursor) qs.set("cursor", cursor);
    const res = await apiGet<{ oris: Ori[]; pageInfo?: { nextCursor: string | null } }>(`/oris?${qs}`);
    all.push(...(res.oris ?? []));
    cursor = res.pageInfo?.nextCursor ?? null;
    if (!cursor) break;
  }
  return all;
}

/**
 * Time until auto-stop, or null when the ori is not running.
 *
 * Returning null for a terminal state is the point: an archived ori is not going to stop, and
 * "0m" next to `archived` actively reads as "about to stop".
 */
export function stopsIn(ori: Ori, now = Date.now()): string | null {
  if (!TICKING.includes(ori.state)) return null;
  if (!ori.archiveAfter) return "never";
  const ms = new Date(ori.archiveAfter).getTime() - now;
  if (ms <= 0) return "due";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function stateVariant(state: string): "success" | "secondary" | "destructive" | "warning" {
  if (state === "ready" || state === "idle") return "success";
  if (state === "error") return "destructive";
  if (state === "running" || state === "provisioning" || state === "cloning" || state === "archiving") return "warning";
  return "secondary";
}


export interface MetricSample {
  at: string;
  cpuPercent: number;
  memBytes: number;
  memLimitBytes: number;
  memPercent: number;
  blockIoBytes: number;
  netIoBytes: number;
}

/** Ids worth asking for metrics about: a stopped sandbox has no live container to sample. */
export function orisRunning(list: { id: string; state: string }[]): string[] {
  return list.filter((o) => RUNNABLE.includes(o.state) || o.state === "running").map((o) => o.id);
}

/** The numbers behind the sparkline, for the cell's tooltip. A picture alone is not a reading. */
export function metricTitle(samples: MetricSample[]): string {
  const last = samples[samples.length - 1];
  if (!last) return "no samples yet — the reaper records one a minute while a sandbox runs";
  const mb = (n: number) => `${(n / 1e6).toFixed(0)}MB`;
  return [
    `CPU ${last.cpuPercent.toFixed(1)}%`,
    `RAM ${mb(last.memBytes)} (${last.memPercent.toFixed(1)}%)`,
    `disk IO ${mb(last.blockIoBytes)}`,
    `net IO ${mb(last.netIoBytes)}`,
    `${samples.length} samples`,
  ].join(" · ");
}
