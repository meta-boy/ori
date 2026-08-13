import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MACHINE_TABLE, type MachineType } from "@ori/contract";
import { GuestClient } from "../guest/client";
import type { BatchCapableDriver, MachineCreateInput, MachineDriver, OriStatSample, SuspendableDriver } from "./types";

/**
 * Systemd as PID 1 in a container needs every one of these flags or it exits
 * 255 (verified on Docker Desktop / arm64, see image/README.md): --privileged
 * gives dockerd inside the ori what it needs, --cgroupns=host + the cgroup
 * mount let systemd manage cgroups, and /run on tmpfs keeps its runtime
 * sockets out of the container's writable layer.
 */
const SYSTEMD_FLAGS = ["--privileged", "--cgroupns=host", "--tmpfs", "/run", "--tmpfs", "/run/lock", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw"];

/** The guest agent listens on :7777 inside every ori. */
const AGENT_PORT = 7777;

/** Boot milestones must clear these deadlines or create() fails. */
const SYSTEMD_READY_TIMEOUT_MS = 90_000;
const AGENT_READY_TIMEOUT_MS = 90_000;
const POLL_MS = 250;

const REPO_ROOT = join(import.meta.dir, "../../../..");
const AGENT_ENTRY = join(REPO_ROOT, "packages/guest-agent/src/index.ts");
const AGENT_CACHE_DIR = join(REPO_ROOT, "node_modules", ".cache", "ori-agent");

/** Where the ori's primary user lives; the guest agent must operate there. */
const AGENT_WORK_DIR = "/home/user";

/**
 * Per-ori environment for the guest agent, mounted into the container read-only.
 *
 * The image's ori-agent.service reads this via `EnvironmentFile=-/etc/ori-agent.env` (it also
 * reads /etc/ori.env for the shared user env). It exists so the agent can start DURING
 * systemd boot with its per-ori identity, instead of the driver waiting for systemd to
 * finish booting and then pushing the env in with two more `docker exec` calls. The legacy
 * path remains for images built before the unit was enabled.
 *
 * NOT under tmpdir(): these files hold agent bearer tokens, and /tmp is shared and
 * world-writable, so any local user can pre-plant `<dir>/<oriId>` as a symlink or a hardlink
 * to a file they own and either read the token or aim a root-owned write wherever they like
 * (CWE-377). The driver already keeps host-side artifacts under the workspace cache — the
 * agent binary lives next door — so the env files live there too, private by construction.
 */
export const AGENT_ENV_DIR = join(REPO_ROOT, "node_modules", ".cache", "ori-agent-env");

/** Where the per-ori agent env file lives. Deterministic per ori id, so destroy can find it. */
function agentEnvPath(oriId: string): string {
  return join(AGENT_ENV_DIR, oriId);
}

/**
 * Write the per-ori env the guest agent needs, 0600: the agent's bearer token, the machine
 * token (the in-box `host` CLI uses it to call /internal/oris/:id/routes, authenticating to
 * the control plane as this ori), and the control-plane origin.
 */
async function writeAgentEnv(oriId: string, agentToken: string, machineToken: string): Promise<string> {
  await mkdir(AGENT_ENV_DIR, { recursive: true, mode: 0o700 });
  const path = agentEnvPath(oriId);
  const controlPlane = process.env.ORI_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
  await writeFile(
    path,
    `ORI_ID=${oriId}\nORI_AGENT_TOKEN=${agentToken}\nORI_MACHINE_TOKEN=${machineToken}\nORI_CONTROL_PLANE=${controlPlane}\nORI_WORK_DIR=${AGENT_WORK_DIR}\n`,
    { mode: 0o600 },
  );
  return path;
}

async function removeAgentEnv(oriId: string): Promise<void> {
  await rm(agentEnvPath(oriId), { force: true }).catch(() => {});
}

export interface DockerDriverOptions {
  /** Image ref to run every ori from. Defaults to the P4-08 base image. */
  image?: string;
  /**
   * Path to a compiled Linux guest-agent binary, mounted into every ori at
   * `/opt/ori/guest-agent/ori-agent`. Defaults to a workspace build cache
   * that is cross-compiled (bun build --compile) on first use.
   */
  agentBinary?: string;
  /**
   * Ceilings applied to EVERY ori, whatever its type asks for. A machine type is a
   * request, not a promise the host can always keep: on a 16GB box also running the
   * control plane, postgres and minio, one `default` (8GB) ori is enough to start
   * swapping. Defaults come from ORI_SANDBOX_MAX_CPUS / ORI_SANDBOX_MAX_MEMORY_MB;
   * unset means the type's own numbers are used unclamped.
   */
  maxCpus?: number;
  maxMemoryMB?: number;
}

/** A positive number from the environment, or undefined. Never throws on junk. */
function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface ManagedOri {
  machineId: string;
  oriId: string;
  name: string;
  ip: string;
}

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A short content hash over every guest-agent source file, used as the compiled binary's
 * cache key. Cheap (a few small files) and it makes staleness impossible rather than
 * something you remember to clear.
 */
async function agentSourceStamp(): Promise<string> {
  const dir = join(REPO_ROOT, "packages/guest-agent/src");
  const files: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".ts")) files.push(p);
    }
  };
  await walk(dir);
  files.sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f.slice(dir.length));
    h.update(await Bun.file(f).text());
  }
  // The api package's own snapshot/restic helpers are imported by the agent, so a change
  // there changes the binary too.
  for (const rel of ["packages/api/src/snapshots/restic.ts"]) {
    const p = join(REPO_ROOT, rel);
    if (existsSync(p)) {
      h.update(rel);
      h.update(await Bun.file(p).text());
    }
  }
  return h.digest("hex").slice(0, 12);
}

/** Is the Docker daemon reachable? The test uses this to skip gracefully off-Docker. */
export async function dockerAvailable(): Promise<boolean> {
  const r = await runCmd(["version", "--format", "{{.Server.Version}}"]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

async function runCmd(args: string[]): Promise<CmdResult> {
  const proc = Bun.spawn({ cmd: ["docker", ...args], stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Run docker, throwing a description of the failure on a non-zero exit. */
async function runChecked(args: string[], context: string): Promise<CmdResult> {
  const r = await runCmd(args);
  if (r.code !== 0) {
    throw new Error(`docker ${context} failed (exit ${r.code}): ${r.stderr || r.stdout}`);
  }
  return r;
}

/**
 * Real MachineDriver backed by Docker containers of the ori-base image.
 * systemd is PID 1, the guest agent runs as ori-agent.service on :7777, and
 * the container's published port is returned as the reachable address
 * (`127.0.0.1:<hostport>`), because on Docker Desktop a container's internal
 * IP is not reachable from the host. `destroy` removes the container.
 */
export class DockerMachineDriver implements MachineDriver, BatchCapableDriver, SuspendableDriver {
  private readonly image: string;
  private readonly agentBinaryOption?: string;
  private readonly maxCpus?: number;
  private readonly maxMemoryMB?: number;
  private readonly machines = new Map<string, ManagedOri>();
  private bunTargetCache?: string;
  /** Whether this.image's ori-agent.service is enabled; see isAgentUnitEnabled. */
  private agentUnitEnabledCache?: boolean;
  /** The one-shot stale-env-file sweep; see sweepStaleAgentEnv. */
  private envSweep?: Promise<void>;

  constructor(options: DockerDriverOptions = {}) {
    this.image = options.image ?? "ori-base:latest";
    this.agentBinaryOption = options.agentBinary;
    this.maxCpus = options.maxCpus ?? envNumber("ORI_SANDBOX_MAX_CPUS");
    this.maxMemoryMB = options.maxMemoryMB ?? envNumber("ORI_SANDBOX_MAX_MEMORY_MB");
  }

  /**
   * `--cpus` / `--memory` for a type. Until this existed the type was decorative:
   * every ori got the whole host, so one runaway build inside a sandbox could OOM the
   * control plane that was supposed to be managing it.
   */
  private resourceFlags(type: MachineType): string[] {
    const spec = MACHINE_TABLE[type] ?? MACHINE_TABLE.default;
    const cpus = Math.min(spec.vcpu, this.maxCpus ?? spec.vcpu);
    const memoryMB = Math.min(spec.memoryGB * 1024, this.maxMemoryMB ?? spec.memoryGB * 1024);
    // Memory without swap accounting would let a container exceed the limit via swap;
    // equal values disable swap for it, which is what a memory ceiling has to mean.
    return ["--cpus", String(cpus), "--memory", `${memoryMB}m`, "--memory-swap", `${memoryMB}m`];
  }

  async create(input: MachineCreateInput): Promise<{ machineId: string; ip: string }> {
    const name = `ori-${input.oriId}`;
    const agentBinary = await this.ensureAgentBinary();
    // Awaited, not fired off: the sweep deletes files whose container does not exist yet, and
    // this create's container does not exist yet either. One docker call, once per process.
    this.envSweep ??= this.sweepStaleAgentEnv().catch(() => {});
    await this.envSweep;
    const envPath = await writeAgentEnv(input.oriId, input.agentToken, input.machineToken);

    // A previous crashed attempt may have left a container under our name;
    // oriIds are unique so anything there is stale and safe to drop.
    await runCmd(["rm", "-f", name]).catch(() => {});

    const runArgs = [
      "run",
      "-d",
      "--name",
      name,
      ...SYSTEMD_FLAGS,
      ...this.resourceFlags(input.type),
      // Reachability: publish the agent's 7777 to an ephemeral loopback port
      // on the host; the ori's own IP is unreachable from here.
      "-p",
      "127.0.0.1::7777",
      // Publish sshd too. A ori whose disk you can read but which you cannot log into is
      // not a ori; `ori ssh` is the headline command. On a real host this is unnecessary —
      // the ori has its own routable IPv4 — but Docker Desktop cannot reach a container IP.
      "-p",
      "127.0.0.1::22",
      // noVNC, bound to LOOPBACK only. The control plane proxies it and checks the signed
      // desktop token; x11vnc itself runs -nopw, so loopback + that token are the entire
      // security model. Never publish this on 0.0.0.0.
      "-p",
      "127.0.0.1::6080",
      // Guest agent injection: the image's ori-agent.service is a no-op until
      // the binary exists at this exact path (ConditionPathExists).
      "-v",
      `${agentBinary}:/opt/ori/guest-agent/ori-agent:ro`,
      // The agent's per-ori identity, readable by the unit at boot (the image's
      // EnvironmentFile=-/etc/ori-agent.env). Mounted read-only; the file itself is 0600.
      "-v",
      `${envPath}:/etc/ori-agent.env:ro`,
      this.image,
    ];

    let containerId: string | null = null;
    try {
      const created = await runChecked(runArgs, `run ${name}`);
      containerId = created.stdout.split("\n")[0];

      const ip = `127.0.0.1:${await this.publishedPort(containerId)}`;
      const guest = GuestClient.forIp(ip, input.agentToken);

      /*
       * Two start paths, one fast and one legacy.
       *
       * FAST (images built after the unit was enabled in provision.sh): the agent starts
       * during systemd boot, in parallel with everything else, because the unit is enabled
       * and its EnvironmentFile points at the file we just mounted. create() then only has
       * to wait for /health — no `systemctl is-system-running` polling loop, no
       * set-environment exec, no enable --now exec. That removes ~N docker CLI spawns per
       * create and starts the agent sooner, which is the whole difference on a slow host.
       *
       * LEGACY (any older image, where the unit is present but disabled): the old two-exec
       * dance — wait for systemd to settle, push the env into the manager, enable --now.
       * The mounted env file is harmless there (the old unit never reads it).
       *
       * One cheap `is-enabled` exec decides which path, so an old image cannot silently
       * hang the fast path's 90s agent timeout.
       */
      const enabled = await this.isAgentUnitEnabled(containerId);
      if (!enabled) {
        await this.waitForSystemd(containerId);
        await runChecked(
          ["exec", containerId, "systemctl", "set-environment", `ORI_ID=${input.oriId}`, `ORI_AGENT_TOKEN=${input.agentToken}`, `ORI_WORK_DIR=${AGENT_WORK_DIR}`],
          `set-environment ${name}`,
        );
        await runChecked(["exec", containerId, "systemctl", "enable", "--now", "ori-agent"], `enable ori-agent ${name}`);
      }

      // create() does not return until the guest agent answers /health, so the
      // caller's provisionToReady never polls a dead port.
      await this.waitForAgent(guest);

      this.machines.set(containerId, { machineId: containerId, oriId: input.oriId, name, ip });
      return { machineId: containerId, ip };
    } catch (e) {
      // Never leave a half-created container behind, nor its env file.
      await runCmd(["rm", "-f", containerId ?? name]).catch(() => {});
      await removeAgentEnv(input.oriId);
      throw e;
    }
  }

  async destroy(machineId: string): Promise<void> {
    const known = this.machines.get(machineId);
    this.machines.delete(machineId);
    const r = await runCmd(["rm", "-f", machineId]);
    if (known) await removeAgentEnv(known.oriId);
    if (r.code !== 0 && !/no such container/i.test(r.stderr)) {
      throw new Error(`docker destroy failed for ${machineId.slice(0, 12)} (exit ${r.code}): ${r.stderr || r.stdout}`);
    }
  }

  /**
   * Warm stop: halt the container but keep it on host disk, so a near-term resume starts it in
   * place instead of restoring from restic. The container is not destroyed and its per-ori env
   * file is kept (the mounted identity the agent reads at next boot). The driver's map entry
   * survives too, so a later destroy still cleans that env file up. Idempotent: stopping an
   * already-stopped or unknown container is a no-op.
   */
  async stop(machineId: string): Promise<void> {
    // -t 5 is enough for systemd to take the agent down cleanly; the default grace is 10s.
    const r = await runCmd(["stop", "-t", "5", machineId]);
    if (r.code !== 0 && !/no such container/i.test(r.stderr)) {
      throw new Error(`docker stop failed for ${machineId.slice(0, 12)} (exit ${r.code}): ${r.stderr || r.stdout}`);
    }
  }

  /**
   * Warm start: bring a stopped container back up and report its CURRENT reachable address.
   *
   * The published host port survives stop/start (the -p mapping is container config, not
   * runtime state), but the address is re-read anyway because nothing guarantees it: a fresh
   * `docker start` can re-attach the bridge with a different internal IP, and re-reading here
   * is what lets the caller record the truth. A container unknown to this process (a warm one
   * that outlived a control-plane restart — this.machines is in-memory) is adopted into the
   * map so a later destroy still removes its env file, like sweepStaleAgentEnv would have.
   */
  async start(machineId: string): Promise<{ ip: string }> {
    await runChecked(["start", machineId], `start ${machineId}`);
    const ip = `127.0.0.1:${await this.publishedPort(machineId)}`;
    const known = this.machines.get(machineId);
    if (known) {
      known.ip = ip;
    } else {
      const r = await runCmd(["inspect", "-f", "{{.Name}}", machineId]);
      const name = r.stdout.trim().replace(/^\//, "");
      if (name.startsWith("ori-")) {
        this.machines.set(machineId, { machineId, oriId: name.slice(4), name, ip });
      }
    }
    return { ip };
  }

  /**
   * Whether the container still exists on this host, stopped or running. This is the warm-tier
   * probe: a container that exists but is not running is a warm candidate, one that does not
   * exist at all means resume must cold-restore from restic. Inspect answers existence, never
   * run-state — deliberately, unlike isAlive.
   */
  async exists(machineId: string): Promise<boolean> {
    const r = await runCmd(["inspect", "-f", "{{.Id}}", machineId]);
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  async ip(machineId: string): Promise<string | null> {
    return this.machines.get(machineId)?.ip ?? null;
  }

  async isAlive(machineId: string): Promise<boolean> {
    const r = await runCmd(["inspect", "-f", "{{.State.Running}}", machineId]);
    if (r.code !== 0) return false;
    return r.stdout === "true";
  }

  /**
   * One `docker ps` for the whole fleet instead of one `docker inspect` per sandbox.
   *
   * The reaper's liveness step calls this when present and falls back to per-ori isAlive
   * otherwise, so a tick's liveness pass costs one docker CLI spawn rather than N. Optional
   * capability, like sampleStats — NOT part of the four-method MachineDriver contract.
   *
   * RUNNING only, exactly like isAlive's `{{.State.Running}}`: nothing here passes `--rm`, so
   * a container whose PID 1 died still exists, and `ps -a` would list it and report a dead
   * sandbox as alive — blinding the reaper to the one condition this step exists to catch.
   *
   * THROWS if docker does not answer. An empty set has to keep meaning "docker answered and
   * nothing is running", because that is a real answer the reaper acts on; returning it for a
   * daemon restart or an EPERM on the socket would mark every live sandbox dead at once.
   */
  async listAliveIds(): Promise<Set<string>> {
    // --no-trunc: `docker ps -q` shortens ids to 12 hex, and machineId is the full 64-hex
    // id from `docker run -d` — a membership test on truncated ids would always miss.
    const r = await runChecked(["ps", "-q", "--no-trunc"], "ps (fleet liveness)");
    return new Set(r.stdout.split("\n").filter(Boolean));
  }

  /**
   * One resource sample per running sandbox, keyed by ori id.
   *
   * Sampled from OUTSIDE the container, and that is not an implementation detail — it is the only
   * place the numbers are correct. Inside a sandbox, /proc/stat reports the HOST's cpu, and
   * because the container runs with --cgroupns=host so systemd can manage cgroups,
   * /sys/fs/cgroup is the host's too. A guest agent asking the kernel "how much cpu am I using"
   * would answer for the whole machine.
   *
   * `docker stats --no-stream` costs one call for the entire fleet rather than one per sandbox,
   * so the reaper's per-tick cost does not grow with the number of oris.
   *
   * NOT part of MachineDriver. That interface is four methods deliberately; this is an optional
   * capability a driver may expose, the same way desktopAddress is.
   */
  async sampleStats(): Promise<Map<string, OriStatSample>> {
    const out = new Map<string, OriStatSample>();
    const r = await runCmd(["stats", "--no-stream", "--format", "{{json .}}"]);
    if (r.code !== 0) return out;

    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      let row: Record<string, string>;
      try {
        row = JSON.parse(line) as Record<string, string>;
      } catch {
        continue;
      }
      /*
       * Match the ori-id SHAPE, not just the `ori-` prefix.
       *
       * A bare prefix check also matched `ori-postgres-1` and `ori-minio-1` — the control
       * plane's own compose containers, which are named after the compose project. They would
       * have been reported as sandboxes. The knownIds filter downstream would have discarded
       * them, so no bad data would have landed, but the bug would have sat there waiting for a
       * container name that happened to collide with a real id.
       */
      const m = /^ori-(or_[23456789abcdefghjkmnpqrstuvwxyz]{8})$/.exec(row.Name ?? "");
      if (!m) continue;
      const oriId = m[1]!;

      out.set(oriId, {
        cpuPercent: parsePercent(row.CPUPerc),
        memBytes: parseFirstSize(row.MemUsage),
        memLimitBytes: parseSecondSize(row.MemUsage),
        blockIoBytes: sumSizes(row.BlockIO),
        netIoBytes: sumSizes(row.NetIO),
        // Filled in below; docker stats knows nothing about any of these.
        diskUsedBytes: 0,
        diskTotalBytes: 0,
        ioPercent: 0,
        topProcesses: [],
      });
    }

    /*
     * Disk, IO contention and processes come from INSIDE each sandbox, one exec each.
     *
     * That is N calls per tick against docker stats's single call, which is why they are gathered
     * in one shell snippet per container rather than three: at a 60s cadence with a handful of
     * sandboxes the cost is irrelevant, and splitting them would triple it for nothing.
     *
     * Every field degrades to its zero rather than failing the sample. A sandbox mid-shutdown
     * will refuse an exec, and one unreadable number must not discard the cpu and memory
     * readings that did work.
     */
    /*
     * Disk USED is the container's writable layer, not `df /`.
     *
     * `df` inside a sandbox reports the whole Docker VM filesystem — it read 28.7 / 1081.1 GB
     * here, a number shared by every container and meaningless as "this sandbox's disk". The
     * writable layer is what this sandbox has actually written. One `docker ps --size` covers the
     * fleet; the TOTAL is the machine type's usable quota and is filled in by the caller, which
     * is the only place that knows the sandbox's type.
     */
    const sizes = await runCmd(["ps", "--size", "--format", "{{.Names}}\t{{.Size}}"]);
    if (sizes.code === 0) {
      for (const line of sizes.stdout.split("\n")) {
        const [name, size] = line.split("\t");
        const m = /^ori-(or_[23456789abcdefghjkmnpqrstuvwxyz]{8})$/.exec(name ?? "");
        if (!m) continue;
        const target = out.get(m[1]!);
        // "1.04GB (virtual 7.81GB)" — the leading figure is the writable layer.
        if (target) target.diskUsedBytes = parseSize((size ?? "").split("(")[0]?.trim());
      }
    }

    await Promise.all(
      [...out.keys()].map(async (oriId) => {
        const enriched = await this.probeInside(oriId).catch(() => null);
        if (!enriched) return;
        Object.assign(out.get(oriId)!, enriched);
      }),
    );

    return out;
  }

  /**
   * One exec per sandbox for the things the daemon cannot see.
   *
   * PSI (/proc/pressure/io) is the interesting one: `avg10` is the percentage of the last ten
   * seconds during which work was stalled waiting on IO. That is a contention figure that belongs
   * on the same 0-100 axis as cpu and memory, unlike docker's cumulative BlockIO byte counters,
   * which only ever increase and say nothing about whether the sandbox is struggling. PSI needs a
   * kernel built with CONFIG_PSI; where it is absent the field stays 0 rather than guessing.
   */
  private async probeInside(oriId: string): Promise<Partial<OriStatSample> | null> {
    const script = [
      // PSI: "some avg10=0.00 avg60=... total=..."
      "cat /proc/pressure/io 2>/dev/null | head -1",
      // top processes by cpu; args last so a command containing spaces survives the split
      "ps -eo pcpu=,rss=,args= --sort=-pcpu 2>/dev/null | head -8",
    ].join("; echo '---'; ");

    const r = await runCmd(["exec", `ori-${oriId}`, "bash", "-lc", script]);
    if (r.code !== 0) return null;

    const [psiPart = "", psPart = ""] = r.stdout.split("---").map((p) => p.trim());
    const psi = /some\s+avg10=([0-9.]+)/.exec(psiPart);

    const topProcesses = psPart
      .split("\n")
      .map((line) => {
        const m = /^\s*([0-9.]+)\s+([0-9]+)\s+(.+)$/.exec(line);
        if (!m) return null;
        return {
          cmd: m[3]!.slice(0, 160),
          cpuPercent: Number(m[1]),
          // ps reports rss in KiB.
          rssBytes: Number(m[2]) * 1024,
        };
      })
      .filter((p): p is { cmd: string; cpuPercent: number; rssBytes: number } => p !== null)
      .slice(0, 8);

    return {
      ioPercent: psi ? Number(psi[1]) : 0,
      topProcesses,
    };
  }

  /** Concrete test accessor (NOT part of the MachineDriver interface). */
  async stopAll(): Promise<void> {
    const ids = [...this.machines.keys()];
    this.machines.clear();
    for (const id of ids) {
      await runCmd(["rm", "-f", id]).catch(() => {});
    }
    // Best-effort sweep: any env file whose container is gone is garbage, and a fresh
    // create overwrites its own anyway.
    await rm(AGENT_ENV_DIR, { recursive: true, force: true }).catch(() => {});
  }

  /* ----------------------------- internals ----------------------------- */

  private async ensureAgentBinary(): Promise<string> {
    if (this.agentBinaryOption) {
      if (!existsSync(this.agentBinaryOption)) {
        throw new Error(`agentBinary does not exist: ${this.agentBinaryOption}`);
      }
      return this.agentBinaryOption;
    }

    const target = await this.bunTarget();
    // Key the cache on the AGENT SOURCE, not just the architecture. Keyed on arch alone,
    // a binary built before a route existed is reused forever: every container ran a stale
    // agent and the guest answered 404 for /snapshot, which surfaced as "final snapshot
    // failed" and left oris unable to stop. A content hash means new source, new file.
    const stamp = await agentSourceStamp();
    const out = join(AGENT_CACHE_DIR, `ori-agent-${target.replace("bun-linux-", "")}-${stamp}`);
    if (existsSync(out)) return out;

    // Build to a temp path and rename so concurrent creates never race on the
    // same output file.
    await mkdir(AGENT_CACHE_DIR, { recursive: true });
    const tmp = join(AGENT_CACHE_DIR, `.tmp-${process.pid}-${Date.now()}`);
    const proc = Bun.spawn({
      cmd: [process.execPath, "build", "--compile", "--target", target, "--outfile", tmp, AGENT_ENTRY],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (code !== 0) {
      await rm(tmp, { force: true }).catch(() => {});
      throw new Error(`guest-agent binary build failed (exit ${code}): ${stderr || stdout}`);
    }
    await rename(tmp, out);
    return out;
  }

  /**
   * bun build --compile produces a host-native binary, so the guest agent must
   * be cross-compiled for the image's architecture (the container runs that
   * architecture even when the host is a different one, e.g. an arm64 Mac
   * emulating nothing but Docker Desktop running an arm64 image).
   */
  private async bunTarget(): Promise<string> {
    if (!this.bunTargetCache) {
      const r = await runChecked(["image", "inspect", "--format", "{{.Architecture}}", this.image], `inspect ${this.image}`);
      const arch = r.stdout;
      if (arch === "amd64") this.bunTargetCache = "bun-linux-x64";
      else if (arch === "arm64") this.bunTargetCache = "bun-linux-arm64";
      else throw new Error(`unsupported image architecture: ${arch}`);
    }
    return this.bunTargetCache;
  }

  /**
   * Is the guest agent's unit enabled in this image? "enabled" means the image was built with
   * the boot-start change and the agent comes up on its own; "disabled" means the legacy
   * two-exec start path must run instead.
   *
   * Memoized: this is a property of the IMAGE, not of the container, so one exec per process
   * answers for every create — probing per create would spend a docker CLI spawn per sandbox
   * to re-learn a constant, and that spawn is a real slice of the boot time this path exists
   * to save. Only a definite answer is cached; an exec that does not answer at all (a
   * container that has not finished starting, a daemon blip) falls back to the legacy path
   * for that create WITHOUT freezing that verdict for the rest of the process's life.
   */
  private async isAgentUnitEnabled(id: string): Promise<boolean> {
    if (this.agentUnitEnabledCache !== undefined) return this.agentUnitEnabledCache;
    const r = await runCmd(["exec", id, "systemctl", "is-enabled", "ori-agent"]);
    const answer = r.stdout.trim();
    if (answer !== "enabled" && answer !== "disabled") return false;
    this.agentUnitEnabledCache = answer === "enabled";
    return this.agentUnitEnabledCache;
  }

  /**
   * Delete env files whose container is gone.
   *
   * `destroy` removes the file for any ori this process created, but `this.machines` is
   * in-memory: after a control-plane restart every destroy of an older sandbox left its token
   * file behind forever. One `docker ps -a` on the first create sweeps them — `-a` on purpose
   * here, since a stopped-but-present container still owns its file.
   */
  private async sweepStaleAgentEnv(): Promise<void> {
    const files = await readdir(AGENT_ENV_DIR).catch(() => [] as string[]);
    if (files.length === 0) return;
    const r = await runCmd(["ps", "-a", "--format", "{{.Names}}"]);
    if (r.code !== 0) return; // No answer, no evidence anything is stale. Next create retries.
    const names = new Set(r.stdout.split("\n").filter(Boolean));
    await Promise.all(files.filter((f) => !names.has(`ori-${f}`)).map((f) => removeAgentEnv(f)));
  }

  private async waitForSystemd(id: string): Promise<void> {
    const deadline = Date.now() + SYSTEMD_READY_TIMEOUT_MS;
    let last = "";
    while (Date.now() < deadline) {
      const r = await runCmd(["exec", id, "systemctl", "is-system-running"]);
      last = r.stdout.trim();
      /*
       * Judge the STATE, never the exit code.
       *
       * `systemctl is-system-running` exits 0 only for "running"; "degraded" exits 1. The old
       * condition was `r.code === 0 && (running || degraded)`, which meant the degraded branch
       * could never be reached — the two halves contradict each other.
       *
       * That was invisible until the image gained a desktop. Before, nothing failed and systemd
       * reached "running". Now a handful of units cannot work in a container no matter what we
       * do (ModemManager wants a modem, udisks2 wants real block devices), so systemd settles
       * at "degraded" — permanently, and correctly. Every ori then failed to provision with
       * "systemd not ready within 90000ms".
       *
       * "degraded" means "booted, some units failed", which is a usable ori. "starting" means
       * keep waiting. Anything else (initializing, maintenance, stopping) also just waits until
       * the deadline.
       */
      if (last === "running" || last === "degraded") return;
      await Bun.sleep(POLL_MS);
    }
    throw new Error(
      `systemd not ready within ${SYSTEMD_READY_TIMEOUT_MS}ms in container ${id.slice(0, 12)} (last state: ${last || "no answer"})`,
    );
  }

  /**
   * The host port sshd is published on, or null when the container has none. Exposed as a
   * driver extra (not part of the four-method MachineDriver) so the sshkey route can tell a
   * caller where to connect: under Docker the ori has no routable IP of its own, so
   * "machineIp" alone cannot describe how to reach it.
   */
  async sshAddress(machineId: string): Promise<{ host: string; port: number } | null> {
    try {
      const r = await runChecked(["port", machineId, "22"], `port ${machineId} 22`);
      const hostPort = r.stdout.trim().split(/[\s:]/).pop();
      const n = Number(hostPort);
      if (!hostPort || !Number.isInteger(n)) return null;
      return { host: "127.0.0.1", port: n };
    } catch {
      return null;
    }
  }

  /**
   * Port-hosting address: where the edge should dial to reach `containerPort` inside this
   * machine.
   *
   * On Linux (the real deployment — Proxmox LXC with Docker inside), the container's bridge
   * IP is reachable from the host, so the edge dials `<bridgeIp>:<containerPort>` directly.
   * On Docker Desktop there is no reachable container IP, so we fall back to a published
   * loopback port — which only exists if the container was created with that port published,
   * so hosting there returns null (honest) rather than a route that cannot connect.
   */
  async hostAddress(machineId: string, containerPort: number): Promise<{ host: string; port: number } | null> {
    const ip = await this.containerIp(machineId);
    if (ip) return { host: ip, port: containerPort };
    try {
      const r = await runChecked(["port", machineId, String(containerPort)], `port ${machineId} ${containerPort}`);
      const hostPort = r.stdout.trim().split(/[\s:]/).pop();
      const n = Number(hostPort);
      if (!hostPort || !Number.isInteger(n)) return null;
      return { host: "127.0.0.1", port: n };
    } catch {
      return null;
    }
  }

  /** The container's bridge IP, or null when the driver cannot see one (Docker Desktop). */
  private async containerIp(machineId: string): Promise<string | null> {
    try {
      const r = await runChecked(
        ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", machineId],
        `inspect ${machineId}`,
      );
      const ip = r.stdout.trim().split(/\s+/)[0] ?? "";
      return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
    } catch {
      return null;
    }
  }

  /** Host address noVNC is published on, or null. Loopback-only by construction. */
  async desktopAddress(machineId: string): Promise<{ host: string; port: number } | null> {
    try {
      const r = await runChecked(["port", machineId, "6080"], `port ${machineId} 6080`);
      const hostPort = r.stdout.trim().split(/[\s:]/).pop();
      const n = Number(hostPort);
      if (!hostPort || !Number.isInteger(n)) return null;
      return { host: "127.0.0.1", port: n };
    } catch {
      return null;
    }
  }

  private async publishedPort(id: string): Promise<number> {
    // `docker port <id> 7777` prints the host binding ("127.0.0.1:53211"; with
    // a bare `docker port <id>` the same binding is prefixed "7777/tcp -> ").
    // The port is whatever follows the last colon or space.
    const r = await runChecked(["port", id, String(AGENT_PORT)], `port ${id}`);
    const hostPort = r.stdout.trim().split(/[\s:]/).pop();
    const n = Number(hostPort);
    if (!hostPort || !Number.isInteger(n)) {
      throw new Error(`no published port for ${AGENT_PORT} on container ${id.slice(0, 12)}: ${r.stdout}`);
    }
    return n;
  }

  private async waitForAgent(guest: GuestClient): Promise<void> {
    const deadline = Date.now() + AGENT_READY_TIMEOUT_MS;
    let lastError = "guest agent never answered /health";
    while (Date.now() < deadline) {
      try {
        const health = await guest.health();
        if (health.ok) return;
        lastError = "guest agent answered /health with ok:false";
      } catch (e) {
        lastError = (e as Error).message;
      }
      await Bun.sleep(POLL_MS);
    }
    throw new Error(`guest agent not healthy within ${AGENT_READY_TIMEOUT_MS}ms: ${lastError}`);
  }
}

/*
 * docker stats emits human strings ("130.7MiB / 17.54GiB", "0.55%", "188kB / 5.86MB"), so these
 * parse rather than trust. Note the unit mix: memory uses binary units (MiB/GiB) and IO uses
 * decimal (kB/MB) in the same output, which is why the table below carries both.
 */
const SIZE_UNITS: Record<string, number> = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

function parseSize(v: string | undefined): number {
  if (!v) return 0;
  const m = v.trim().match(/^([0-9.]+)\s*([a-zA-Z]+)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  return n * (SIZE_UNITS[m[2]!.toLowerCase()] ?? 1);
}

function parsePercent(v: string | undefined): number {
  const n = Number((v ?? "").replace("%", "").trim());
  return Number.isFinite(n) ? n : 0;
}

/** "130.7MiB / 17.54GiB" -> the left side. */
function parseFirstSize(v: string | undefined): number {
  return parseSize((v ?? "").split("/")[0]);
}

/** "130.7MiB / 17.54GiB" -> the right side. */
function parseSecondSize(v: string | undefined): number {
  return parseSize((v ?? "").split("/")[1]);
}

/** "188kB / 5.86MB" -> both sides added, since read+write together is what a sparkline shows. */
function sumSizes(v: string | undefined): number {
  const parts = (v ?? "").split("/");
  return parseSize(parts[0]) + parseSize(parts[1]);
}
