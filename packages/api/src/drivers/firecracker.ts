import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MACHINE_TABLE, type MachineType } from "@ori/contract";
import { GuestClient } from "../guest/client";
import type {
  BatchCapableDriver,
  CreatedMachine,
  MachineCreateInput,
  MachineDriver,
  SuspendableDriver,
  WarmFootprintDriver,
} from "./types";

const DEFAULT_SUBNET = "172.30.0.0/16";
const DEFAULT_STATE_DIR = "/var/lib/ori/fc";
const DEFAULT_BRIDGE = "ori-fc0";

/** Machine id for an ori id. Also the per-machine state dir name under the state dir. */
export function machineIdFor(oriId: string): string {
  return `fc-${oriId}`;
}

/** A deterministic, IFNAMSIZ-safe (<=15 chars) tap name per machine. */
export function tapNameFor(machineId: string): string {
  const digest = createHash("sha256").update(machineId).digest("hex").slice(0, 11);
  return `tap-${digest}`;
}

/** A locally-administered unicast MAC derived from the guest IP, unique per VM on a bridge. */
export function macForIp(ip: string): string {
  const hex = (value: number) => value.toString(16).padStart(2, "0");
  return `02:fc:${ip.split(".").map((octet) => hex(Number(octet))).join(":")}`;
}

/** Everything the driver persists about a machine, at <stateDir>/<machineId>/metadata.json. */
export interface MachineMetadata {
  machineId: string;
  oriId: string;
  /** Per-ori agent token, persisted so the driver can reach the guest agent on resume. */
  agentToken: string;
  type: MachineType;
  ip: string;
  mac: string;
  tapName: string;
  kernelPath: string;
  rootfsPath: string;
  seedImagePath: string | null;
  seedDirPath: string | null;
  seedFromMke2fs: boolean;
  agentBinaryPath: string;
  apiSocketPath: string;
  logPath: string;
  firecrackerVersion: string | null;
  pid: number | null;
  snapshotVmstatePath: string | null;
  snapshotMemPath: string | null;
  snapshotFirecrackerVersion: string | null;
  memFileBytes: number | null;
}

export interface FcSpawnOptions {
  apiSocket: string;
  logPath: string;
  cwd: string;
}

/**
 * Every shell-out and socket call the driver makes, injectable so tests can fake the host
 * side (ip link, mke2fs, cp, firecracker spawn, /proc liveness) and the FC API.
 */
export interface FirecrackerDeps {
  linkAdd(tap: string, bridge: string): Promise<void>;
  linkDelete(tap: string): Promise<void>;
  hasMke2fs(): Promise<boolean>;
  mke2fsFromDir(rootDir: string, imagePath: string): Promise<void>;
  copyReflink(src: string, dest: string): Promise<void>;
  firecrackerVersion(): Promise<string>;
  spawnFirecracker(options: FcSpawnOptions): Promise<{ pid: number }>;
  processAlive(pid: number): Promise<boolean>;
  killProcess(pid: number): Promise<void>;
  fcRequest(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number }>;
  /**
   * Best-effort post-resume clock step: the guest's clock is frozen at suspend time, so
   * tell the guest agent the wall-clock epoch it should believe it is. Failures must
   * never fail the start — a running sandbox with a stale clock beats a dead one.
   */
  clockStep(metadata: MachineMetadata): Promise<void>;
}

export interface FirecrackerDriverOptions {
  subnet?: string;
  stateDir?: string;
  bridge?: string;
  kernel?: string;
  rootfs?: Partial<Record<MachineType, string>>;
  agentBinary?: string;
  deps?: Partial<FirecrackerDeps>;
}

/** Marks a connection-level failure (VMM socket not up yet); retried, unlike HTTP errors. */
class FcUnavailable extends Error {}

/** How long start() waits on the best-effort post-resume clock step before giving up. */
const CLOCK_STEP_TIMEOUT_MS = 5000;

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCmd(args: string[]): Promise<CmdResult> {
  const proc = Bun.spawn({ cmd: args, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function runChecked(args: string[], context: string): Promise<CmdResult> {
  const r = await runCmd(args);
  if (r.code !== 0) throw new Error(`${context} failed (exit ${r.code}): ${r.stderr || r.stdout}`);
  return r;
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSizeBytes(p);
    else total += Bun.file(p).size;
  }
  return total;
}

const defaultDeps: FirecrackerDeps = {
  async linkAdd(tap, bridge) {
    await runChecked(["ip", "tuntap", "add", "dev", tap, "mode", "tap"], `ip tuntap add ${tap}`);
    await runChecked(["ip", "link", "set", tap, "master", bridge], `ip link set ${tap} master ${bridge}`);
    await runChecked(["ip", "link", "set", tap, "up"], `ip link set ${tap} up`);
  },
  async linkDelete(tap) {
    const r = await runCmd(["ip", "link", "del", tap]);
    if (r.code !== 0 && !r.stderr.includes("No such device")) {
      throw new Error(`ip link del ${tap} failed (exit ${r.code}): ${r.stderr || r.stdout}`);
    }
  },
  async hasMke2fs() {
    // Bun.which, not `command -v`: the latter is a shell builtin, and Bun.spawn does not
    // run a shell. Caught by the first real-host e2e run.
    return Bun.which("mke2fs") != null;
  },
  async mke2fsFromDir(rootDir, imagePath) {
    // 20% + 8MB headroom: ext4's journal, inode tables and reserved blocks are paid out of
    // the same block count, and a 95MB agent binary with 1MB of margin fails to populate.
    // Caught on the first real-host e2e run.
    const payload = await dirSizeBytes(rootDir);
    const blocks = Math.max(4096, Math.ceil((payload * 1.2) / 1024) + 8192);
    await runChecked(
      ["mke2fs", "-d", rootDir, "-o", "Linux", "-t", "ext4", imagePath, String(blocks)],
      `mke2fs -d ${rootDir}`,
    );
  },
  async copyReflink(src, dest) {
    await runChecked(["cp", "--reflink=auto", src, dest], `cp --reflink=auto ${src}`);
  },
  async firecrackerVersion() {
    const r = await runCmd(["firecracker", "--version"]);
    const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
    return m?.[1] ?? r.stdout.trim();
  },
  async spawnFirecracker(options) {
    const proc = Bun.spawn({
      cmd: ["firecracker", "--api-sock", options.apiSocket],
      cwd: options.cwd,
      stdout: Bun.file(options.logPath),
      stderr: Bun.file(options.logPath),
    });
    return { pid: proc.pid };
  },
  async processAlive(pid) {
    try {
      const comm = await readFile(`/proc/${pid}/comm`, "utf8");
      return comm.trim() === "firecracker";
    } catch {
      return false;
    }
  },
  async killProcess(pid) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  },
  async fcRequest(socketPath, method, path, body) {
    try {
      const res = await fetch(`http://unix/${path}`, {
        method,
        unix: socketPath,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status };
    } catch (err) {
      throw new FcUnavailable(`firecracker api socket ${socketPath} unavailable: ${String(err)}`);
    }
  },
  async clockStep(metadata) {
    const client = GuestClient.forIp(metadata.ip, metadata.agentToken);
    await client.clock(Date.now());
  },
};

async function sendFc(deps: FirecrackerDeps, socketPath: string, method: string, path: string, body?: unknown): Promise<void> {
  const maxTries = 12;
  for (let i = 0; i < maxTries; i++) {
    try {
      const result = await deps.fcRequest(socketPath, method, path, body);
      if (result.status >= 300) throw new Error(`firecracker ${method} ${path} failed: HTTP ${result.status}`);
      return;
    } catch (err) {
      if (!(err instanceof FcUnavailable) || i === maxTries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function ipv4ToInt(address: string): number {
  const octets = address.split(".").map(Number);
  return ((((octets[0] << 24) | (octets[1] << 16)) | (octets[2] << 8)) | octets[3]) >>> 0;
}

function intToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function subnetInfo(subnet: string): { network: number; prefix: number; gateway: string; netmask: string } {
  const [base, prefixRaw] = subnet.split("/");
  const prefix = Number(prefixRaw);
  if (!base || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`invalid subnet: ${subnet}`);
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = ipv4ToInt(base) & mask;
  return {
    network,
    prefix,
    gateway: intToIpv4(network + 1),
    netmask: intToIpv4(mask),
  };
}

/** First unused host IP; skips the network, the bridge/gateway and the broadcast address. */
function firstFreeHostIp(subnet: string, used: Set<string>): string | null {
  const info = subnetInfo(subnet);
  const hostCount = 2 ** (32 - info.prefix);
  for (let offset = 2; offset < hostCount - 1; offset++) {
    const ip = intToIpv4(info.network + offset);
    if (!used.has(ip)) return ip;
  }
  return null;
}

/**
 * Boot + warm-suspend Firecracker MachineDriver: one bridge + one tap per machine, a
 * driver-allocated guest IP passed via the kernel ip= boot arg, a reflink rootfs copy and a
 * seed disk (agent binary + per-ori identity env), all persisted as per-machine metadata so
 * allocation and artifacts survive control-plane restarts. Implements SuspendableDriver via
 * memory snapshots: stop pauses + snapshots the VMM (mem + vmstate into the machine dir) and
 * kills it; start reloads the snapshot on a fresh VMM, returning the guest's persisted IP.
 */
export class FirecrackerMachineDriver implements MachineDriver, SuspendableDriver, BatchCapableDriver, WarmFootprintDriver {
  private readonly subnet: string;
  private readonly stateDir: string;
  private readonly bridge: string;
  private readonly kernel: string;
  private readonly rootfs: Partial<Record<MachineType, string>>;
  private readonly agentBinary?: string;
  private readonly deps: FirecrackerDeps;

  constructor(options: FirecrackerDriverOptions = {}) {
    this.subnet = options.subnet ?? process.env.ORI_FC_SUBNET ?? DEFAULT_SUBNET;
    this.stateDir = options.stateDir ?? process.env.ORI_FC_STATE_DIR ?? DEFAULT_STATE_DIR;
    this.bridge = options.bridge ?? process.env.ORI_FC_BRIDGE ?? DEFAULT_BRIDGE;
    this.kernel = options.kernel ?? process.env.ORI_FC_KERNEL ?? "";
    this.rootfs = options.rootfs ?? {};
    this.agentBinary = options.agentBinary ?? process.env.ORI_FC_AGENT_BINARY ?? undefined;
    this.deps = { ...defaultDeps, ...options.deps };
  }

  private rootfsSource(type: MachineType): string {
    return (
      this.rootfs[type] ??
      process.env[`ORI_FC_ROOTFS_${type.toUpperCase()}`] ??
      process.env.ORI_FC_ROOTFS ??
      ""
    );
  }

  private agentEnv(input: MachineCreateInput): string {
    const controlPlane = process.env.ORI_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
    return `ORI_ID=${input.oriId}\nORI_AGENT_TOKEN=${input.agentToken}\nORI_MACHINE_TOKEN=${input.machineToken}\nORI_CONTROL_PLANE=${controlPlane}\n`;
  }

  private bootArgs(ip: string): string {
    const info = subnetInfo(this.subnet);
    return `console=ttyS0 reboot=k panic=1 pci=off ip=${ip}::${info.gateway}:${info.netmask}::eth0:off random.trust_cpu=on`;
  }

  private metadataPath(machineId: string): string {
    return join(this.stateDir, machineId, "metadata.json");
  }

  private async writeMetadata(metadata: MachineMetadata): Promise<void> {
    await writeFile(this.metadataPath(metadata.machineId), JSON.stringify(metadata, null, 2), { mode: 0o600 });
  }

  private async readMetadata(machineId: string): Promise<MachineMetadata | null> {
    try {
      const raw = await readFile(this.metadataPath(machineId), "utf8");
      return JSON.parse(raw) as MachineMetadata;
    } catch {
      return null;
    }
  }

  private async allocateIp(): Promise<string> {
    const used = new Set<string>();
    try {
      for (const entry of await readdir(this.stateDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const meta = await this.readMetadata(entry.name);
        if (meta?.ip) used.add(meta.ip);
      }
    } catch {}
    const ip = firstFreeHostIp(this.subnet, used);
    if (!ip) throw new Error(`no free IP in subnet ${this.subnet}`);
    return ip;
  }

  async create(input: MachineCreateInput): Promise<CreatedMachine> {
    const spec = MACHINE_TABLE[input.type];
    if (!spec) throw new Error(`unknown machine type: ${input.type}`);

    const machineId = machineIdFor(input.oriId);
    const machineDir = join(this.stateDir, machineId);

    const kernelPath = this.kernel;
    const rootfsSource = this.rootfsSource(input.type);
    const agentBinary = this.agentBinary;
    if (!kernelPath) throw new Error("firecracker kernel not configured (set ORI_FC_KERNEL)");
    if (!rootfsSource) {
      throw new Error(
        `no rootfs configured for type ${input.type} (set ORI_FC_ROOTFS_${input.type.toUpperCase()} or ORI_FC_ROOTFS)`,
      );
    }
    if (!agentBinary) throw new Error("firecracker guest-agent binary not configured (set ORI_FC_AGENT_BINARY)");

    const ip = await this.allocateIp();
    const metadata: MachineMetadata = {
      machineId,
      oriId: input.oriId,
      agentToken: input.agentToken,
      type: input.type,
      ip,
      mac: macForIp(ip),
      tapName: tapNameFor(machineId),
      kernelPath,
      rootfsPath: join(machineDir, "rootfs.ext4"),
      seedImagePath: null,
      seedDirPath: null,
      seedFromMke2fs: false,
      agentBinaryPath: agentBinary,
      apiSocketPath: join(machineDir, "firecracker.sock"),
      logPath: join(machineDir, "firecracker.log"),
      firecrackerVersion: null,
      pid: null,
      snapshotVmstatePath: null,
      snapshotMemPath: null,
      snapshotFirecrackerVersion: null,
      memFileBytes: null,
    };

    await mkdir(machineDir, { recursive: true, mode: 0o700 });
    try {
      await this.writeMetadata(metadata);

      // Delete-then-add: a tap left behind by a crashed VMM (kill -9, host OOM) makes a bare
      // add fail with TUNSETIFF busy forever. The name is derived from the machine id, so a
      // leftover can only be ours. Caught twice on the first real-host e2e day.
      await this.deps.linkDelete(metadata.tapName).catch(() => {});
      await this.deps.linkAdd(metadata.tapName, this.bridge);
      await this.deps.copyReflink(rootfsSource, metadata.rootfsPath);

      const seedDir = join(machineDir, "seed");
      await mkdir(seedDir, { recursive: true, mode: 0o700 });
      await this.deps.copyReflink(agentBinary, join(seedDir, "ori-agent"));
      // "ori.env", not "ori-agent.env": ori-seed.service installs this file to /etc/ori.env,
      // the EnvironmentFile ori-agent.service already reads. The seed payload names are the
      // contract between this driver and image/vm-overlay.
      await writeFile(join(seedDir, "ori.env"), this.agentEnv(input), { mode: 0o600 });

      if (await this.deps.hasMke2fs()) {
        metadata.seedImagePath = join(machineDir, "seed.ext4");
        await this.deps.mke2fsFromDir(seedDir, metadata.seedImagePath);
        metadata.seedFromMke2fs = true;
      } else {
        metadata.seedDirPath = seedDir;
      }
      await this.writeMetadata(metadata);

      const spawned = await this.deps.spawnFirecracker({
        apiSocket: metadata.apiSocketPath,
        logPath: metadata.logPath,
        cwd: machineDir,
      });
      metadata.pid = spawned.pid;
      metadata.firecrackerVersion = await this.deps.firecrackerVersion().catch(() => null);
      await this.writeMetadata(metadata);

      await sendFc(this.deps, metadata.apiSocketPath, "PUT", "/boot-source", {
        kernel_image_path: kernelPath,
        boot_args: this.bootArgs(ip),
      });
      // Drive and network-interface ids ride the PATH (/drives/{id}), not the body — the
      // real VMM 400s the collection form. Caught on the first real-host e2e run.
      await sendFc(this.deps, metadata.apiSocketPath, "PUT", "/drives/rootfs", {
        drive_id: "rootfs",
        path_on_host: metadata.rootfsPath,
        is_root_device: true,
        is_read_only: false,
      });
      if (metadata.seedImagePath) {
        await sendFc(this.deps, metadata.apiSocketPath, "PUT", "/drives/seed", {
          drive_id: "seed",
          path_on_host: metadata.seedImagePath,
          is_root_device: false,
          is_read_only: true,
        });
      }
      await sendFc(this.deps, metadata.apiSocketPath, "PUT", "/machine-config", {
        vcpu_count: spec.vcpu,
        mem_size_mib: spec.memoryGB * 1024,
        smt: false,
      });
      await sendFc(this.deps, metadata.apiSocketPath, "PUT", "/network-interfaces/eth0", {
        iface_id: "eth0",
        host_dev_name: metadata.tapName,
        guest_mac: metadata.mac,
      });
      await sendFc(this.deps, metadata.apiSocketPath, "PUT", "/actions", {
        action_type: "InstanceStart",
      });

      return { machineId, ip };
    } catch (err) {
      await this.destroy(machineId).catch(() => {});
      throw err;
    }
  }

  async destroy(machineId: string): Promise<void> {
    const metadata = await this.readMetadata(machineId);
    if (metadata) {
      if (metadata.pid != null && (await this.deps.processAlive(metadata.pid))) {
        await this.deps.killProcess(metadata.pid);
      }
      if (metadata.tapName) {
        await this.deps.linkDelete(metadata.tapName).catch(() => {});
      }
    }
    await rm(join(this.stateDir, machineId), { recursive: true, force: true });
  }

  async stop(machineId: string): Promise<void> {
    const metadata = await this.readMetadata(machineId);
    if (!metadata || metadata.pid == null) return;

    const machineDir = join(this.stateDir, machineId);
    const snapshotVmstatePath = join(machineDir, "snapshot.vmstate");
    const snapshotMemPath = join(machineDir, "snapshot.mem");

    await sendFc(this.deps, metadata.apiSocketPath, "PATCH", "/vm", { state: "Paused" });
    await sendFc(this.deps, metadata.apiSocketPath, "PUT", "/snapshot/create", {
      snapshot_type: "Full",
      snapshot_path: snapshotVmstatePath,
      mem_file_path: snapshotMemPath,
    });
    const memFileBytes = (await stat(snapshotMemPath)).size;
    const snapshotFirecrackerVersion = await this.deps.firecrackerVersion().catch(() => null);

    await this.deps.killProcess(metadata.pid);
    await this.deps.linkDelete(metadata.tapName).catch(() => {});

    await this.writeMetadata({
      ...metadata,
      pid: null,
      firecrackerVersion: null,
      snapshotVmstatePath,
      snapshotMemPath,
      snapshotFirecrackerVersion,
      memFileBytes,
    });
  }

  async start(machineId: string): Promise<{ ip: string }> {
    const metadata = await this.readMetadata(machineId);
    if (!metadata) throw new Error(`unknown machine: ${machineId}`);
    if (!metadata.snapshotVmstatePath || !metadata.snapshotMemPath) {
      throw new Error(`machine ${machineId} has no warm snapshot to resume (cold-restorable)`);
    }

    const coldRestore = async (reason: string): Promise<never> => {
      if (metadata.pid != null) await this.deps.killProcess(metadata.pid).catch(() => {});
      await this.deps.linkDelete(metadata.tapName).catch(() => {});
      await rm(metadata.snapshotVmstatePath!, { force: true }).catch(() => {});
      await rm(metadata.snapshotMemPath!, { force: true }).catch(() => {});
      await this.writeMetadata({
        ...metadata,
        snapshotVmstatePath: null,
        snapshotMemPath: null,
        snapshotFirecrackerVersion: null,
        memFileBytes: null,
      });
      throw new Error(`${reason} — snapshot artifacts removed; machine left cold-restorable`);
    };

    try {
      const memStat = await stat(metadata.snapshotMemPath);
      if (memStat.size === 0) return coldRestore(`snapshot mem file ${metadata.snapshotMemPath} is empty`);
      await stat(metadata.snapshotVmstatePath);
    } catch {
      return coldRestore(`snapshot artifacts for machine ${machineId} are missing or unreadable`);
    }

    const version = await this.deps.firecrackerVersion().catch(() => null);
    if (version !== metadata.snapshotFirecrackerVersion) {
      return coldRestore(
        `snapshot version mismatch for ${machineId}: saved with ${metadata.snapshotFirecrackerVersion}, host has ${version}`,
      );
    }

    // Same delete-then-add as create(): a stale tap must never wedge a warm start.
    await this.deps.linkDelete(metadata.tapName).catch(() => {});
    await this.deps.linkAdd(metadata.tapName, this.bridge);
    // The dead VMM leaves its unix socket file behind, and firecracker refuses to bind an
    // existing path — the fresh VMM exits instantly and snapshot/load talks to a corpse.
    await rm(metadata.apiSocketPath, { force: true }).catch(() => {});
    let pid: number | null = null;
    try {
      const spawned = await this.deps.spawnFirecracker({
        apiSocket: metadata.apiSocketPath,
        logPath: metadata.logPath,
        cwd: join(this.stateDir, machineId),
      });
      pid = spawned.pid;
      // mem_backend, not the deprecated mem_file_path: verified against Firecracker v1.10.1,
      // where the File backend is the documented way to hand the mem file back.
      await sendFc(this.deps, metadata.apiSocketPath, "PUT", "/snapshot/load", {
        snapshot_path: metadata.snapshotVmstatePath,
        mem_backend: { backend_type: "File", backend_path: metadata.snapshotMemPath },
        enable_diff_snapshots: false,
        resume_vm: true,
      });
    } catch (err) {
      if (pid != null) await this.deps.killProcess(pid).catch(() => {});
      return coldRestore(`snapshot load failed for ${machineId}: ${String(err)}`);
    }

    await this.writeMetadata({
      ...metadata,
      pid,
      firecrackerVersion: version,
      snapshotVmstatePath: null,
      snapshotMemPath: null,
      snapshotFirecrackerVersion: null,
      memFileBytes: null,
    });

    // A resumed VM wakes with its clock frozen at suspend time (FC snapshots don't carry
    // the wall clock). Step it toward the host's clock, best-effort: a running sandbox
    // with a stale clock beats a dead one, so a clock-step failure is logged into the
    // machine's log file and never fails the start.
    const stepError = await Promise.race([
      this.deps
        .clockStep(metadata)
        .then(() => null)
        .catch((err) => err as Error),
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("clock step timed out")), CLOCK_STEP_TIMEOUT_MS)),
    ]);
    if (stepError) {
      await writeFile(metadata.logPath, `clock-step failed: ${stepError.message}\n`, { flag: "a" }).catch(() => {});
    }
    return { ip: metadata.ip };
  }

  async exists(machineId: string): Promise<boolean> {
    const metadata = await this.readMetadata(machineId);
    if (!metadata?.snapshotVmstatePath || !metadata?.snapshotMemPath) return false;
    try {
      await stat(metadata.snapshotVmstatePath);
      await stat(metadata.snapshotMemPath);
      return true;
    } catch {
      return false;
    }
  }

  async warmFootprint(): Promise<Map<string, { bytes: number; archivedAtMs: number | null }>> {
    const footprint = new Map<string, { bytes: number; archivedAtMs: number | null }>();
    const statSize = async (path: string): Promise<number> => {
      try {
        return (await stat(path)).size;
      } catch {
        return 0;
      }
    };
    for (const entry of await readdir(this.stateDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metadata = await this.readMetadata(entry.name);
      if (!metadata?.snapshotMemPath || !metadata?.snapshotVmstatePath) continue;
      let archivedAtMs: number | null = null;
      try {
        archivedAtMs = (await stat(metadata.snapshotMemPath)).mtimeMs;
      } catch {}
      const bytes =
        (metadata.memFileBytes ?? 0) + (await statSize(metadata.snapshotVmstatePath)) + (await statSize(metadata.rootfsPath));
      footprint.set(entry.name, { bytes, archivedAtMs });
    }
    return footprint;
  }

  async ip(machineId: string): Promise<string | null> {
    return (await this.readMetadata(machineId))?.ip ?? null;
  }

  async isAlive(machineId: string): Promise<boolean> {
    const metadata = await this.readMetadata(machineId);
    if (metadata?.pid == null) return false;
    return this.deps.processAlive(metadata.pid);
  }

  async listAliveIds(): Promise<Set<string>> {
    const aliveIds = new Set<string>();
    // readdir throws on an unreachable/missing state dir, and that error must propagate:
    // the reaper's contract is that an unanswered backend degrades to per-machine isAlive
    // instead of being told the whole fleet is dead. A corrupt per-machine metadata file is
    // the opposite — skipped, not fatal.
    for (const entry of await readdir(this.stateDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metadata = await this.readMetadata(entry.name);
      if (metadata?.pid != null && (await this.deps.processAlive(metadata.pid))) {
        aliveIds.add(entry.name);
      }
    }
    return aliveIds;
  }

  async sshAddress(machineId: string): Promise<{ host: string; port: number } | null> {
    const ip = await this.ip(machineId);
    return ip ? { host: ip, port: 22 } : null;
  }

  async hostAddress(machineId: string, containerPort: number): Promise<{ host: string; port: number } | null> {
    const ip = await this.ip(machineId);
    return ip ? { host: ip, port: containerPort } : null;
  }

  async desktopAddress(machineId: string): Promise<{ host: string; port: number } | null> {
    const ip = await this.ip(machineId);
    return ip ? { host: ip, port: 6080 } : null;
  }
}
