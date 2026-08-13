import type { RequestableMachineType } from "@ori/contract";

/** Inputs every driver needs to bring a machine up. `image` is the base image ref. */
export interface MachineCreateInput {
  oriId: string;
  type: RequestableMachineType;
  image: string;
  /** Scoped control-plane credential the ori uses to call `/internal/oris/:id/*`. */
  machineToken: string;
  /** Credential the control plane uses to call the guest agent on :7777. */
  agentToken: string;
}

export interface CreatedMachine {
  machineId: string;
  ip: string;
}

/**
 * §5 MachineDriver. Exactly four methods and nothing else — all in-ori work
 * goes through the guest agent at the machine's ip:7777.
 */
export interface MachineDriver {
  create(input: MachineCreateInput): Promise<CreatedMachine>;
  destroy(machineId: string): Promise<void>;
  ip(machineId: string): Promise<string | null>;
  isAlive(machineId: string): Promise<boolean>;
}

/** One resource sample for a sandbox. Bytes and percent, never docker's display strings. */
export interface OriStatSample {
  cpuPercent: number;
  memBytes: number;
  memLimitBytes: number;
  blockIoBytes: number;
  netIoBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  /** IO contention as a percentage of stalled time, from kernel PSI. */
  ioPercent: number;
  topProcesses: Array<{ cmd: string; cpuPercent: number; rssBytes: number }>;
}

/**
 * Fleet-wide shortcuts a driver MAY implement, declared here so the reaper can probe for them
 * without casting to an anonymous shape at each call site.
 *
 * Both answer for every sandbox in one call where the four-method contract above would need
 * one call per sandbox per tick. Both are strictly optional: a driver without them (the fake
 * one, and Incus until it grows an implementation) loses the shortcut and nothing else — the
 * reaper falls back to per-ori isAlive, and metrics simply record nothing rather than
 * fabricating flat lines.
 *
 * Deliberately NOT folded into MachineDriver: §5 fixes that contract at four methods, and a
 * driver that cannot batch must stay a legal driver.
 */
/**
 * Optional driver capability: the host-side address to dial to reach `containerPort` inside
 * a machine. Needed by `host <port>` — the edge proxies to THIS address. A driver without
 * it cannot host ports (the machine has no address the edge can reach), which is a fine
 * answer for the fake driver in tests that never touch the network, but the docker driver
 * on Linux resolves the container's bridge IP and hosts work.
 */
export interface PortHostingDriver {
  hostAddress(machineId: string, containerPort: number): Promise<{ host: string; port: number } | null>;
}

/**
 * Optional driver capability: the warm stop/resume tier.
 *
 * A driver with it can suspend a machine in place (stop it while keeping it on host disk) and
 * start it again later, so a near-term resume starts the machine instead of restoring from
 * restic. `stop` must leave the machine on disk — only its processes stop; `start` must bring
 * it back up and return its CURRENT reachable address, because starting can change it (docker
 * start re-attaches the bridge and may assign a new IP). `exists` answers whether the machine
 * is on this host at all, stopped or running — it is what lets resume tell "warm, just start
 * it" from "gone, restore from restic".
 *
 * Deliberately NOT folded into MachineDriver: §5 fixes that contract at four methods, and a
 * driver whose backend cannot keep a stopped machine around (or an old driver) must stay a
 * legal driver — stop then destroys, and every resume is the cold path.
 */
export interface SuspendableDriver {
  /** Stop the machine but keep it on host disk. Idempotent; unknown id is a no-op. */
  stop(machineId: string): Promise<void>;
  /** Start a stopped machine and return its current reachable address. Throws if absent. */
  start(machineId: string): Promise<{ ip: string }>;
  /** Whether the machine still exists on this host, stopped or running. */
  exists(machineId: string): Promise<boolean>;
}

export interface BatchCapableDriver {
  /**
   * Ids of the machines that are RUNNING — the batched form of isAlive, and it must agree
   * with isAlive machine for machine.
   *
   * MUST throw if the backend cannot answer. An empty set means "answered, nothing is
   * running", which the reaper acts on by marking those machines dead; returning it for a
   * transport failure would kill the whole fleet at once.
   */
  listAliveIds?(): Promise<Set<string>>;
  /** One resource sample per running sandbox, keyed by ORI id (not machine id). */
  sampleStats?(): Promise<Map<string, OriStatSample>>;
}

/**
 * Optional driver capability: host-disk cost of the warm tier, for fleet-wide eviction.
 *
 * Reports, per machine currently holding warm artifacts (snapshot mem + vmstate present on
 * host disk, so a near-term start skips the cold path), the host bytes those artifacts cost.
 * Oldest-first eviction is the caller's job — this only answers what is warm and at what
 * cost, so a capacity planner can decide what to discard. Machines without snapshot
 * artifacts are absent from the map.
 *
 * Deliberately NOT folded into MachineDriver, like the other optional capabilities: a
 * driver whose backend cannot keep a suspended machine on disk (or an old driver) must stay
 * a legal driver.
 */
export interface WarmFootprintDriver {
  /**
   * Per machine id currently holding warm artifacts: host bytes those artifacts occupy, and
   * the snapshot's archive timestamp (`archivedAtMs` null when it cannot be read).
   */
  warmFootprint(): Promise<Map<string, { bytes: number; archivedAtMs: number | null }>>;
}
