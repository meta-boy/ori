import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MACHINE_TABLE, REQUESTABLE_TYPES, oriId } from "@ori/contract";
import {
  FirecrackerMachineDriver,
  machineIdFor,
  macForIp,
  tapNameFor,
  type FirecrackerDeps,
  type FirecrackerDriverOptions,
  type MachineMetadata,
} from "@ori/api/drivers/firecracker";
import type { MachineDriver } from "@ori/api/drivers/types";

const KERNEL = "/opt/ori/vmlinux.bin";
const ROOTFS: Partial<Record<"nano" | "small" | "default" | "large", string>> = {
  nano: "/img/nano.ext4",
  small: "/img/small.ext4",
  default: "/img/default.ext4",
  large: "/img/large.ext4",
};

function makeInput(over: Partial<Parameters<MachineDriver["create"]>[0]> = {}) {
  return {
    oriId: oriId(),
    type: "default" as const,
    image: "n/a",
    machineToken: "ori_mt_fc_test",
    agentToken: "ori_at_fc_test",
    ...over,
  };
}

interface FcRequestRecord {
  method: string;
  path: string;
  body: any;
}

function makeHarness(over: Partial<FirecrackerDeps> = {}) {
  const fcRequests: FcRequestRecord[] = [];
  const linkAdds: string[][] = [];
  const linkDeletes: string[][] = [];
  const mke2fsCalls: string[][] = [];
  const copies: string[][] = [];
  const spawns: { pid: number; apiSocket: string }[] = [];
  const killed: number[] = [];
  const alive = new Set<number>();
  const clockSteps: string[] = [];
  let pidCounter = 90_000;

  const deps: FirecrackerDeps = {
    async linkAdd(tap, bridge) {
      linkAdds.push([tap, bridge]);
    },
    async linkDelete(tap) {
      linkDeletes.push([tap]);
    },
    async hasMke2fs() {
      return true;
    },
    async mke2fsFromDir(rootDir, imagePath) {
      mke2fsCalls.push([rootDir, imagePath]);
    },
    async copyReflink(src, dest) {
      copies.push([src, dest]);
    },
    async firecrackerVersion() {
      return "1.6.0";
    },
    async spawnFirecracker(options) {
      const pid = ++pidCounter;
      spawns.push({ pid, apiSocket: options.apiSocket });
      alive.add(pid);
      return { pid };
    },
    async processAlive(pid) {
      return alive.has(pid);
    },
    async killProcess(pid) {
      killed.push(pid);
      alive.delete(pid);
    },
    async fcRequest(socketPath, method, path, body) {
      fcRequests.push({ method, path, body });
      if (method === "PUT" && path === "/snapshot/create" && body) {
        const snapshot = body as { mem_file_path: string; snapshot_path: string };
        await writeFile(snapshot.mem_file_path, "fake-mem", { mode: 0o600 });
        await writeFile(snapshot.snapshot_path, "fake-vmstate", { mode: 0o600 });
      }
      return { status: 204 };
    },
    async clockStep(metadata) {
      clockSteps.push(metadata.machineId);
    },
    ...over,
  };

  return { deps, fcRequests, linkAdds, linkDeletes, mke2fsCalls, copies, spawns, killed, alive, clockSteps };
}

/** A real HTTP-over-unix-socket server standing in for the Firecracker API. */
async function startFcServer(socketPath: string): Promise<{ requests: FcRequestRecord[]; stop: () => void }> {
  const requests: FcRequestRecord[] = [];
  const server = Bun.serve({
    unix: socketPath,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      const text = await req.text().catch(() => "");
      if (req.method === "GET" && path === "/") return new Response("", { status: 200 });
      let body: unknown;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {}
      }
      requests.push({ method: req.method, path, body });
      return new Response("", { status: 204 });
    },
  });
  return {
    requests,
    stop: () => {
      server.stop(true);
      void rm(socketPath, { force: true }).catch(() => {});
    },
  };
}

async function readMetadata(machineDir: string): Promise<MachineMetadata> {
  return JSON.parse(await readFile(join(machineDir, "metadata.json"), "utf8"));
}

describe("FirecrackerMachineDriver", () => {
  let stateDir: string;
  let agentBinary: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "ori-fc-"));
    agentBinary = join(stateDir, "agent.bin");
    await writeFile(agentBinary, "fake-agent", { mode: 0o700 });
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  function makeDriver(h: ReturnType<typeof makeHarness>, over: FirecrackerDriverOptions = {}) {
    return new FirecrackerMachineDriver({ stateDir, kernel: KERNEL, rootfs: ROOTFS, agentBinary, deps: h.deps, ...over });
  }

  test("implements the §5 MachineDriver interface (structural check)", () => {
    const driver: MachineDriver = makeDriver(makeHarness());
    for (const m of ["create", "destroy", "ip", "isAlive"]) {
      expect(typeof (driver as any)[m]).toBe("function");
    }
  });

  test("machine-config is built from MACHINE_TABLE for every requestable type", async () => {
    for (const type of REQUESTABLE_TYPES) {
      const h = makeHarness();
      const driver = makeDriver(h);
      const created = await driver.create(makeInput({ type }));

      const config = h.fcRequests.find((r) => r.path === "/machine-config");
      expect(config).toBeDefined();
      const spec = MACHINE_TABLE[type];
      expect(config!.body).toEqual({ vcpu_count: spec.vcpu, mem_size_mib: spec.memoryGB * 1024, smt: false });

      const boot = h.fcRequests.find((r) => r.path === "/boot-source");
      expect(boot!.body.kernel_image_path).toBe(KERNEL);
      expect(boot!.body.boot_args).toContain(`ip=${created.ip}`);

      const net = h.fcRequests.find((r) => r.path === "/network-interfaces/eth0");
      expect(net!.body.host_dev_name).toBe(tapNameFor(created.machineId));
      expect(net!.body.guest_mac).toBe(macForIp(created.ip));

      const root = h.fcRequests.find((r) => r.path === "/drives/rootfs");
      expect(root!.body.is_root_device).toBe(true);
    }
  });

  test("IP allocation is stable and persists across a fresh driver instance", async () => {
    const first = await makeDriver(makeHarness()).create(makeInput());
    expect(first.ip).toBe("172.30.0.2");

    const fresh = makeDriver(makeHarness());
    expect(await fresh.ip(first.machineId)).toBe(first.ip);

    const second = await fresh.create(makeInput());
    expect(second.ip).toBe("172.30.0.3");
    expect(second.ip).not.toBe(first.ip);
  });

  test("two creates never share an IP", async () => {
    const driver = makeDriver(makeHarness());
    const ips = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const created = await driver.create(makeInput());
      ips.add(created.ip);
    }
    expect(ips.size).toBe(3);
    expect([...ips]).toEqual(["172.30.0.2", "172.30.0.3", "172.30.0.4"]);
  });

  test("metadata round-trip records oriId, ip, tap, type, artifacts and FC version", async () => {
    const h = makeHarness();
    const input = makeInput({ type: "small", agentToken: "ori_at_fc_meta" });
    const driver = makeDriver(h);
    const created = await driver.create(input);
    const machineDir = join(stateDir, created.machineId);
    expect(created.machineId).toBe(machineIdFor(input.oriId));

    const meta = await readMetadata(machineDir);
    expect(meta.oriId).toBe(input.oriId);
    expect(meta.agentToken).toBe(input.agentToken);
    expect(meta.type).toBe("small");
    expect(meta.ip).toBe(created.ip);
    expect(meta.mac).toBe(macForIp(created.ip));
    expect(meta.tapName).toBe(tapNameFor(created.machineId));
    expect(meta.tapName.length).toBeLessThanOrEqual(15);
    expect(meta.kernelPath).toBe(KERNEL);
    expect(meta.rootfsPath).toBe(join(machineDir, "rootfs.ext4"));
    expect(meta.seedImagePath).toBe(join(machineDir, "seed.ext4"));
    expect(meta.seedFromMke2fs).toBe(true);
    expect(meta.agentBinaryPath).toBe(agentBinary);
    expect(meta.apiSocketPath).toBe(join(machineDir, "firecracker.sock"));
    expect(meta.firecrackerVersion).toBe("1.6.0");
    expect(meta.pid).toBe(h.spawns[0]!.pid);

    const seedEnv = await readFile(join(machineDir, "seed", "ori.env"), "utf8");
    expect(seedEnv).toContain(`ORI_ID=${input.oriId}`);
    expect(seedEnv).toContain(`ORI_AGENT_TOKEN=${input.agentToken}`);
    expect(seedEnv).toContain(`ORI_MACHINE_TOKEN=${input.machineToken}`);
  });

  test("when mke2fs is absent the seed dir is left populated and noted in metadata", async () => {
    const h = makeHarness({ hasMke2fs: async () => false });
    const created = await makeDriver(h).create(makeInput());
    const meta = await readMetadata(join(stateDir, created.machineId));

    expect(meta.seedFromMke2fs).toBe(false);
    expect(meta.seedImagePath).toBeNull();
    expect(meta.seedDirPath).toBe(join(stateDir, created.machineId, "seed"));
    expect(h.mke2fsCalls).toHaveLength(0);
    await expect(stat(join(stateDir, created.machineId, "seed", "ori.env"))).resolves.toBeDefined();
    await expect(stat(join(stateDir, created.machineId, "seed"))).resolves.toBeDefined();

    const drives = h.fcRequests.filter((r) => r.path.startsWith("/drives/"));
    expect(drives.map((d) => d.body.drive_id)).toEqual(["rootfs"]);
  });

  test("destroy kills the VMM, deletes the tap, removes the dir and releases the IP", async () => {
    const h = makeHarness();
    const driver = makeDriver(h);
    const first = await driver.create(makeInput());
    const pid = h.spawns[0]!.pid;
    expect(await driver.isAlive(first.machineId)).toBe(true);

    await driver.destroy(first.machineId);

    expect(h.killed).toContain(pid);
    expect(h.linkDeletes.filter((d) => d[0] === tapNameFor(first.machineId)).length).toBeGreaterThanOrEqual(1);
    await expect(stat(join(stateDir, first.machineId))).rejects.toThrow();
    expect(await driver.ip(first.machineId)).toBeNull();
    expect(await driver.isAlive(first.machineId)).toBe(false);

    const second = await driver.create(makeInput());
    expect(second.ip).toBe(first.ip);
  });

  test("destroy of an unknown machine is a no-op", async () => {
    await expect(makeDriver(makeHarness()).destroy("fc-nope")).resolves.toBeUndefined();
  });

  test("isAlive is false when the pid is missing or the process is dead", async () => {
    const h = makeHarness();
    const driver = makeDriver(h);
    const created = await driver.create(makeInput());
    const pid = h.spawns[0]!.pid;

    expect(await driver.isAlive(created.machineId)).toBe(true);
    expect(await driver.isAlive("fc-nope")).toBe(false);

    h.alive.delete(pid);
    expect(await driver.isAlive(created.machineId)).toBe(false);

    const metaPath = join(stateDir, created.machineId, "metadata.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    await writeFile(metaPath, JSON.stringify({ ...meta, pid: null }));
    expect(await driver.isAlive(created.machineId)).toBe(false);

    await writeFile(metaPath, JSON.stringify({ machineId: created.machineId, ip: "172.30.0.9" }));
    expect(await driver.isAlive(created.machineId)).toBe(false);
    expect(await driver.ip(created.machineId)).toBe("172.30.0.9");
  });

  test("configures the FC API over the unix socket in order", async () => {
    const h = makeHarness();
    delete (h.deps as any).fcRequest;
    const input = makeInput();
    const machineDir = join(stateDir, machineIdFor(input.oriId));
    await mkdir(machineDir, { recursive: true });
    const server = await startFcServer(join(machineDir, "firecracker.sock"));
    try {
      await makeDriver(h).create(input);

      expect(server.requests.map((r) => [r.method, r.path])).toEqual([
        ["PUT", "/boot-source"],
        ["PUT", "/drives/rootfs"],
        ["PUT", "/drives/seed"],
        ["PUT", "/machine-config"],
        ["PUT", "/network-interfaces/eth0"],
        ["PUT", "/actions"],
      ]);
      const drives = server.requests.filter((r) => r.path.startsWith("/drives/"));
      expect(drives.map((d) => d.body.drive_id)).toEqual(["rootfs", "seed"]);
      const actions = server.requests.find((r) => r.path === "/actions");
      expect(actions!.body).toEqual({ action_type: "InstanceStart" });
    } finally {
      server.stop();
    }
  });

  test("sshAddress/hostAddress/desktopAddress return the plain guest IP", async () => {
    const driver = makeDriver(makeHarness());
    const created = await driver.create(makeInput());

    expect(await driver.sshAddress(created.machineId)).toEqual({ host: created.ip, port: 22 });
    expect(await driver.hostAddress(created.machineId, 3000)).toEqual({ host: created.ip, port: 3000 });
    expect(await driver.desktopAddress(created.machineId)).toEqual({ host: created.ip, port: 6080 });
    expect(await driver.sshAddress("fc-nope")).toBeNull();
  });

  test("stop pauses, snapshots, kills the VMM, deletes the tap and records snapshot metadata", async () => {
    const h = makeHarness();
    const driver = makeDriver(h);
    const created = await driver.create(makeInput());
    const machineDir = join(stateDir, created.machineId);
    const pid = h.spawns[0]!.pid;
    const before = h.fcRequests.length;

    await driver.stop(created.machineId);

    expect(h.fcRequests.slice(before).map((r) => [r.method, r.path])).toEqual([
      ["PATCH", "/vm"],
      ["PUT", "/snapshot/create"],
    ]);
    expect(h.fcRequests[before]!.body).toEqual({ state: "Paused" });
    expect(h.fcRequests[before + 1]!.body).toEqual({
      snapshot_type: "Full",
      snapshot_path: join(machineDir, "snapshot.vmstate"),
      mem_file_path: join(machineDir, "snapshot.mem"),
    });
    expect(h.killed).toEqual([pid]);
    expect(h.linkDeletes.filter((d) => d[0] === tapNameFor(created.machineId)).length).toBeGreaterThanOrEqual(1);
    expect(await driver.isAlive(created.machineId)).toBe(false);

    const meta = await readMetadata(machineDir);
    expect(meta.pid).toBeNull();
    expect(meta.snapshotVmstatePath).toBe(join(machineDir, "snapshot.vmstate"));
    expect(meta.snapshotMemPath).toBe(join(machineDir, "snapshot.mem"));
    expect(meta.snapshotFirecrackerVersion).toBe("1.6.0");
    expect(meta.memFileBytes).toBe(8);
  });

  test("stop is idempotent when the machine is already stopped", async () => {
    const h = makeHarness();
    const driver = makeDriver(h);
    const created = await driver.create(makeInput());
    await driver.stop(created.machineId);

    const requests = h.fcRequests.length;
    const killed = h.killed.length;
    const deleted = h.linkDeletes.length;

    await driver.stop(created.machineId);

    expect(h.fcRequests.length).toBe(requests);
    expect(h.killed.length).toBe(killed);
    expect(h.linkDeletes.length).toBe(deleted);
    await expect(driver.stop("fc-nope")).resolves.toBeUndefined();
  });

  test("start recreates the tap, loads the snapshot with resume_vm and returns the SAME ip", async () => {
    const h = makeHarness();
    const driver = makeDriver(h);
    const created = await driver.create(makeInput());
    await driver.stop(created.machineId);
    expect(await driver.exists(created.machineId)).toBe(true);

    const resumed = await driver.start(created.machineId);

    expect(resumed.ip).toBe(created.ip);
    expect(h.linkAdds).toEqual([
      [tapNameFor(created.machineId), "ori-fc0"],
      [tapNameFor(created.machineId), "ori-fc0"],
    ]);
    const load = h.fcRequests.find((r) => r.path === "/snapshot/load");
    expect(load).toBeDefined();
    expect(load!.body).toEqual({
      snapshot_path: join(stateDir, created.machineId, "snapshot.vmstate"),
      mem_backend: { backend_type: "File", backend_path: join(stateDir, created.machineId, "snapshot.mem") },
      enable_diff_snapshots: false,
      resume_vm: true,
    });
    expect(h.spawns).toHaveLength(2);

    const meta = await readMetadata(join(stateDir, created.machineId));
    expect(meta.pid).toBe(h.spawns[1]!.pid);
    expect(meta.ip).toBe(created.ip);
    expect(meta.snapshotVmstatePath).toBeNull();
    expect(meta.snapshotMemPath).toBeNull();
    expect(meta.snapshotFirecrackerVersion).toBeNull();
    expect(meta.memFileBytes).toBeNull();
    expect(await driver.isAlive(created.machineId)).toBe(true);
    expect(await driver.exists(created.machineId)).toBe(false);
  });

  test("start() steps the guest clock after a successful load", async () => {
    const h = makeHarness();
    const driver = makeDriver(h);
    const created = await driver.create(makeInput());
    await driver.stop(created.machineId);

    const resumed = await driver.start(created.machineId);

    expect(resumed.ip).toBe(created.ip);
    expect(h.clockSteps).toEqual([created.machineId]);
    const log = await readFile(join(stateDir, created.machineId, "firecracker.log"), "utf8").catch(() => "");
    expect(log).not.toContain("clock-step failed");
  });

  test("start() swallows a clock-step failure, logs it, and still returns the machine", async () => {
    const h = makeHarness({
      clockStep: async (metadata) => {
        throw new Error("agent not reachable");
      },
    });
    const driver = makeDriver(h);
    const created = await driver.create(makeInput());
    await driver.stop(created.machineId);

    const resumed = await driver.start(created.machineId);

    expect(resumed.ip).toBe(created.ip);
    expect(await driver.isAlive(created.machineId)).toBe(true);
    const log = await readFile(join(stateDir, created.machineId, "firecracker.log"), "utf8");
    expect(log).toContain("clock-step failed");
    expect(log).toContain("agent not reachable");
  });

  test("start with a firecracker version mismatch throws and removes the snapshot artifacts", async () => {
    let version = "1.6.0";
    const h = makeHarness({ firecrackerVersion: async () => version });
    const driver = makeDriver(h);
    const created = await driver.create(makeInput());
    await driver.stop(created.machineId);
    const machineDir = join(stateDir, created.machineId);

    version = "1.7.0";

    await expect(driver.start(created.machineId)).rejects.toThrow(/version mismatch/i);
    await expect(stat(join(machineDir, "snapshot.vmstate"))).rejects.toThrow();
    await expect(stat(join(machineDir, "snapshot.mem"))).rejects.toThrow();

    const meta = await readMetadata(machineDir);
    expect(meta.snapshotVmstatePath).toBeNull();
    expect(meta.snapshotMemPath).toBeNull();
    expect(meta.snapshotFirecrackerVersion).toBeNull();
    expect(meta.memFileBytes).toBeNull();
    expect(await driver.exists(created.machineId)).toBe(false);
    expect(await driver.ip(created.machineId)).toBe(created.ip);
  });

  test("start with a corrupt/missing mem file throws and removes the snapshot artifacts", async () => {
    const h = makeHarness();
    const driver = makeDriver(h);
    const created = await driver.create(makeInput());
    await driver.stop(created.machineId);
    const machineDir = join(stateDir, created.machineId);
    await rm(join(machineDir, "snapshot.mem"));

    await expect(driver.start(created.machineId)).rejects.toThrow(/missing or unreadable/i);
    await expect(stat(join(machineDir, "snapshot.vmstate"))).rejects.toThrow();
    const meta = await readMetadata(machineDir);
    expect(meta.snapshotVmstatePath).toBeNull();
    expect(meta.snapshotMemPath).toBeNull();
    expect(await driver.exists(created.machineId)).toBe(false);
  });

  test("start with a load failure kills the fresh VMM, removes artifacts and throws", async () => {
    const h = makeHarness({
      fcRequest: async (socketPath, method, path, body) => {
        if (method === "PUT" && path === "/snapshot/create" && body) {
          const snapshot = body as { mem_file_path: string; snapshot_path: string };
          await writeFile(snapshot.mem_file_path, "fake-mem", { mode: 0o600 });
          await writeFile(snapshot.snapshot_path, "fake-vmstate", { mode: 0o600 });
        }
        if (method === "PUT" && path === "/snapshot/load") return { status: 500 };
        return { status: 204 };
      },
    });
    const driver = makeDriver(h);
    const created = await driver.create(makeInput());
    await driver.stop(created.machineId);
    const machineDir = join(stateDir, created.machineId);

    await expect(driver.start(created.machineId)).rejects.toThrow(/load failed/i);
    expect(h.killed).toEqual([h.spawns[0]!.pid, h.spawns[1]!.pid]);
    await expect(stat(join(machineDir, "snapshot.vmstate"))).rejects.toThrow();
    await expect(stat(join(machineDir, "snapshot.mem"))).rejects.toThrow();
    expect(await driver.exists(created.machineId)).toBe(false);
    expect(await driver.isAlive(created.machineId)).toBe(false);
  });

  test("exists is true only when metadata and both snapshot artifacts are present", async () => {
    const h = makeHarness();
    const driver = makeDriver(h);
    const created = await driver.create(makeInput());
    const machineDir = join(stateDir, created.machineId);

    expect(await driver.exists(created.machineId)).toBe(false);
    expect(await driver.exists("fc-nope")).toBe(false);

    await driver.stop(created.machineId);
    expect(await driver.exists(created.machineId)).toBe(true);

    await rm(join(machineDir, "snapshot.mem"));
    expect(await driver.exists(created.machineId)).toBe(false);
  });

  test("listAliveIds returns only the running machine and skips a corrupt metadata file", async () => {
    const h = makeHarness();
    const driver = makeDriver(h);
    const running = await driver.create(makeInput());
    const stopped = await driver.create(makeInput());
    await driver.stop(stopped.machineId);

    const corrupt = await driver.create(makeInput());
    await writeFile(join(stateDir, corrupt.machineId, "metadata.json"), "{ not json");

    const alive = await driver.listAliveIds();
    expect([...alive]).toEqual([running.machineId]);
    expect(alive.has(stopped.machineId)).toBe(false);
    expect(alive.has(corrupt.machineId)).toBe(false);
  });

  test("listAliveIds throws when the state dir is missing entirely", async () => {
    const h = makeHarness();
    const driver = makeDriver(h, { stateDir: join(stateDir, "does-not-exist") });
    await expect(driver.listAliveIds()).rejects.toThrow();
  });

  test("warmFootprint reports only the warm machine with summed artifact bytes and a finite archivedAtMs", async () => {
    const h = makeHarness();
    const driver = makeDriver(h);
    await driver.create(makeInput());
    const warm = await driver.create(makeInput());
    await driver.stop(warm.machineId);
    const machineDir = join(stateDir, warm.machineId);

    const footprint = await driver.warmFootprint();
    expect([...footprint.keys()]).toEqual([warm.machineId]);

    const memSize = (await stat(join(machineDir, "snapshot.mem"))).size;
    const vmstateSize = (await stat(join(machineDir, "snapshot.vmstate"))).size;
    const entry = footprint.get(warm.machineId)!;
    expect(entry.bytes).toBe(memSize + vmstateSize);
    expect(entry.archivedAtMs).not.toBeNull();
    expect(Number.isFinite(entry.archivedAtMs)).toBe(true);
  });

  test("warmFootprint returns an empty map when nothing is warm", async () => {
    const h = makeHarness();
    const driver = makeDriver(h);
    await driver.create(makeInput());

    const footprint = await driver.warmFootprint();
    expect(footprint.size).toBe(0);
  });
});
