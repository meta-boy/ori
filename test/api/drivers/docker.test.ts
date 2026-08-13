import { describe, expect, test, afterEach } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_ENV_DIR, DockerMachineDriver, dockerAvailable } from "@ori/api/drivers/docker";
import type { MachineDriver } from "@ori/api/drivers/types";
import { oriIp } from "@ori/api/serialize";
import { GuestClient } from "@ori/api/guest/client";
import { oriId } from "@ori/contract";

const hasDocker = await dockerAvailable();

function makeInput(over: Partial<Parameters<MachineDriver["create"]>[0]> = {}) {
  return {
    oriId: oriId(),
    type: "default" as const,
    image: "ubuntu-24.04",
    machineToken: "ori_mt_docker_test",
    agentToken: "ori_at_docker_test",
    ...over,
  };
}

/** Does a container with this id still exist (even stopped)? */
async function containerExists(id: string): Promise<boolean> {
  const proc = Bun.spawn({ cmd: ["docker", "inspect", "-f", "{{.Id}}", id], stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return code === 0 && out.trim().length > 0;
}

describe("T-P4-07 Ori.ip contract", () => {
  test("a host:port reachability address is not an IP, so Ori.ip is null", () => {
    // The docker driver returns 127.0.0.1:<hostport> — the control plane's
    // loopback, not the ori's routable IPv4. The honest public answer is null.
    expect(oriIp("127.0.0.1:53211")).toBeNull();
    expect(oriIp(null)).toBeNull();
    // A bare dotted-quad (the incus driver, P12) is a real IP and passes through.
    expect(oriIp("203.0.113.10")).toBe("203.0.113.10");
  });
});

describe.skipIf(!hasDocker)("T-P4-07 DockerMachineDriver (real containers)", () => {
  const driver = new DockerMachineDriver();

  afterEach(async () => {
    // Never leave a container behind, including when an assertion failed.
    await driver.stopAll();
  });

  test("implements the §5 MachineDriver interface (structural check)", () => {
    const d: MachineDriver = driver;
    const methods = ["create", "destroy", "ip", "isAlive"];
    for (const m of methods) expect(typeof (d as any)[m]).toBe("function");
  });

  test("create boots a real container and the guest agent answers /health through GuestClient", async () => {
    const agentToken = "ori_at_docker_lifecycle";
    const input = makeInput({ agentToken });
    const created = await driver.create(input);

    // Full container id, and a loopback-host published port (Docker Desktop
    // cannot reach a container's internal IP from the host).
    expect(created.machineId).toMatch(/^[0-9a-f]{64}$/);
    expect(created.ip).toMatch(/^127\.0\.0\.1:\d+$/);

    expect(await driver.isAlive(created.machineId)).toBe(true);
    expect(await driver.ip(created.machineId)).toBe(created.ip);
    expect(await driver.ip("m_nope")).toBeNull();
    expect(await driver.isAlive("m_nope")).toBe(false);

    // The control plane reaches the real guest agent through the returned ip.
    const health = await GuestClient.forIp(created.ip, agentToken).health();
    expect(health.ok).toBe(true);
    expect(health.oriId).toBe(input.oriId);
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  }, 240_000);

  test("destroy removes the container; isAlive is false and the container is gone", async () => {
    const input = makeInput({ agentToken: "ori_at_docker_destroy" });
    const created = await driver.create(input);
    expect(await containerExists(created.machineId)).toBe(true);

    await driver.destroy(created.machineId);

    expect(await driver.isAlive(created.machineId)).toBe(false);
    // Gone, not merely stopped: docker inspect finds nothing at all.
    expect(await containerExists(created.machineId)).toBe(false);
  }, 240_000);

  test("listAliveIds answers for the whole fleet in one call", async () => {
    const input = makeInput({ agentToken: "ori_at_docker_listalive" });
    const created = await driver.create(input);

    const alive = await driver.listAliveIds();
    expect(alive.has(created.machineId)).toBe(true);

    await driver.destroy(created.machineId);
    const after = await driver.listAliveIds();
    expect(after.has(created.machineId)).toBe(false);
  }, 240_000);

  test("listAliveIds agrees with isAlive about a stopped-but-present container", async () => {
    // The reason this test exists: nothing here passes --rm, so a sandbox whose PID 1 died
    // still EXISTS. `docker ps -a` would list it and the reaper's batched liveness pass would
    // call it alive — going blind to the exact condition it exists to catch. Both answers
    // must key on running, not on existence.
    const input = makeInput({ agentToken: "ori_at_docker_stopped" });
    const created = await driver.create(input);
    try {
      await Bun.spawn({ cmd: ["docker", "stop", "-t", "1", created.machineId], stdout: "ignore", stderr: "ignore" }).exited;
      expect(await containerExists(created.machineId)).toBe(true); // present...
      expect(await driver.isAlive(created.machineId)).toBe(false); // ...but not running
      expect((await driver.listAliveIds()).has(created.machineId)).toBe(false);
    } finally {
      await driver.destroy(created.machineId);
    }
  }, 240_000);

  test("the per-ori agent env file is mounted at /etc/ori-agent.env and removed on destroy", async () => {
    const input = makeInput({ agentToken: "ori_at_docker_envfile" });
    const created = await driver.create(input);
    try {
      const proc = Bun.spawn({
        cmd: ["docker", "inspect", "-f", "{{json .Mounts}}", created.machineId],
        stdout: "pipe",
      });
      const mounts = JSON.parse(await new Response(proc.stdout).text()) as {
        Source: string;
        Destination: string;
        RW: boolean;
      }[];
      const envMount = mounts.find((m) => m.Destination === "/etc/ori-agent.env");
      expect(envMount).toBeDefined();
      expect(envMount!.RW).toBe(false); // read-only: the container must not edit its identity
      // Docker Desktop reports bind sources inside its VM as /host_mnt/<host path>;
      // on Linux the source IS the host path. Strip the VM prefix before comparing, and
      // realpath the expected side: macOS /var is a symlink to /private/var, and the
      // bind source is the resolved path.
      const hostSource = envMount!.Source.replace(/^\/host_mnt/, "");
      expect(hostSource).toBe(await realpath(join(AGENT_ENV_DIR, input.oriId)));
      // The file itself holds the agent token, so it must be 0600 on the host.
      const st = await Bun.file(hostSource).stat();
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      await driver.destroy(created.machineId);
    }
    // Destroy cleans the host-side file up with the container.
    const after = await driver.listAliveIds();
    expect(after.has(created.machineId)).toBe(false);
    const stale = await Bun.file(join(AGENT_ENV_DIR, input.oriId)).exists();
    expect(stale).toBe(false);
  }, 240_000);

  test("the machine type becomes a real cgroup limit, clamped by the host ceilings", async () => {
    // Ceilings below the type's own numbers, so this asserts the clamp and not
    // just that some limit was passed. `small` is 2 vCPU / 4GB.
    const limited = new DockerMachineDriver({ maxCpus: 1, maxMemoryMB: 1024 });
    const created = await limited.create(makeInput({ type: "small", agentToken: "ori_at_docker_limits" }));
    try {
      const proc = Bun.spawn({
        cmd: ["docker", "inspect", "-f", "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}", created.machineId],
        stdout: "pipe",
      });
      const [nanoCpus, memory, swap] = (await new Response(proc.stdout).text()).trim().split(" ").map(Number);
      expect(nanoCpus).toBe(1_000_000_000); // 1 cpu, not small's 2
      expect(memory).toBe(1024 * 1024 * 1024); // 1GB, not small's 4
      expect(swap).toBe(memory); // no escaping the ceiling via swap
    } finally {
      await limited.stopAll();
    }
  }, 240_000);

  test("destroy of an unknown machine is a no-op", async () => {
    await expect(driver.destroy("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).resolves.toBeUndefined();
  });
});
