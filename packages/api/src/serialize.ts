import { MACHINE_TABLE, type MachineType } from "@ori/contract";
import { EDGE_DOMAIN } from "./constants";
import type { oris } from "./db/schema";

export type OriRow = typeof oris.$inferSelect;

/**
 * The public Ori.ip is documented as a machine IPv4. The docker driver's
 * reachable address is `127.0.0.1:<hostport>` — that is the control plane's
 * loopback, not the ori's IP, and stripping the port would still lie about
 * where the ori is. The honest answer is null when there is no routable
 * address; a bare dotted-quad (the incus driver, P12) is exposed as-is.
 */
export function oriIp(ip: string | null): string | null {
  if (!ip || ip.includes(":")) return null;
  return ip;
}

/** Map a DB ori row to the API Ori shape (OriSchema). */
export function toOri(row: OriRow): Record<string, unknown> {
  const spec = MACHINE_TABLE[row.type as MachineType] ?? null;
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    type: row.type,
    ...(spec ? { vcpu: spec.vcpu, memoryGB: spec.memoryGB, billingMultiplier: spec.billingMultiplier } : {}),
    url: row.subdomain ? `https://${row.subdomain}.${EDGE_DOMAIN}` : null,
    ip: oriIp(row.ip),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archiveAfter: row.archiveAfter ? row.archiveAfter.toISOString() : null,
    desktopAvailable: row.desktopAvailable,
    desktopUrl: null,
    snapshotAvailable: row.snapshotAvailable,
    snapshotCompletedAt: row.snapshotCompletedAt ? row.snapshotCompletedAt.toISOString() : null,
    subdomain: row.subdomain ?? null,
    // Both of these come straight from the real API's Ori shape, which was compared field
    // by field against ours: lastSnapshotAttemptAt was the ONLY difference. It is in the
    // spec, and the column already existed -- it simply was never serialized, so a client
    // could not tell "no snapshot yet" from "tried and failed a minute ago".
    lastSnapshotAttemptAt: row.lastSnapshotAttemptAt?.toISOString() ?? null,
    lastSnapshotStatus: row.lastSnapshotStatus ?? null,
  };
}
