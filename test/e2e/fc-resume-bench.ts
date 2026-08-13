/**
 * e2e-fc-bench — REAL Firecracker snapshot-resume benchmark.
 *
 * Boots a nano microVM under KVM, starts a counter process inside the guest, then snapshots
 * and resumes it three times while measuring BOOT_MS, SNAPSHOT_MS, the snapshot mem size and
 * RESUME_MS (start() call → /health answering again). It FAILs (exit 1) when the median
 * resume exceeds ORI_FC_RESUME_BUDGET_MS (default 1000). The counter surviving with its state
 * advanced, and the guest clock being stepped back to ~host time, prove the resume restored
 * the live VM rather than a fresh boot.
 *
 * Required host environment (same as test/e2e/firecracker.ts):
 *   - `firecracker` on PATH
 *   - /dev/kvm — a Linux host with KVM
 *   - ORI_FC_KERNEL        path to a vmlinux kernel image
 *   - ORI_FC_ROOTFS        path to a nano rootfs ext4 image
 *   - ORI_FC_AGENT_BINARY  path to the ori guest-agent binary (the driver hard-requires it)
 *   - root, to create the tap and attach it to the bridge
 *
 * Any missing PROBED prerequisite prints "SKIPPED - <reason>" and exits 0. Run with
 * `make e2e-fc-bench`.
 */
import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FirecrackerMachineDriver, type MachineMetadata } from "@ori/api/drivers/firecracker";
import type { CreatedMachine } from "@ori/api/drivers/types";
import { GuestClient } from "@ori/api/guest/client";

const CYCLES = 3;
const COUNTER_PATH = "fc-bench-counter";
/** Detached counter loop: writes "<epoch> <count>" each second, survives the snapshot. */
const MARKER =
  `sh -c 'i=0; while true; do i=$((i+1)); ` +
  `printf "%s %s\\n" "$(date +%s)" "$i" > /home/user/${COUNTER_PATH}; sleep 1; done' ` +
  `>/dev/null 2>&1 </dev/null & disown; echo $!`;

interface ExecOut {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function readMachineMetadata(stateDir: string, machineId: string): Promise<MachineMetadata | null> {
  try {
    const raw = await readFile(join(stateDir, machineId, "metadata.json"), "utf8");
    return JSON.parse(raw) as MachineMetadata;
  } catch {
    return null;
  }
}

async function waitHealthy(ip: string, agentToken: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${ip}:7777/health`, {
        headers: { authorization: `Bearer ${agentToken}` },
      });
      if (res.status === 200) return true;
    } catch {
      // VMM down between snapshot and resume, or agent not up yet — keep polling.
    }
    await Bun.sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Preflight. Skip (exit 0) rather than fail when this host cannot run a microVM.
// ---------------------------------------------------------------------------
if (!(await Bun.which("firecracker"))) {
  console.log("e2e-fc-bench: SKIPPED - firecracker is not on PATH");
  process.exit(0);
}
if (!(await pathExists("/dev/kvm"))) {
  console.log("e2e-fc-bench: SKIPPED - /dev/kvm is missing (needs a Linux host with KVM)");
  process.exit(0);
}
const kernel = process.env.ORI_FC_KERNEL;
if (!kernel || !(await pathExists(kernel))) {
  console.log("e2e-fc-bench: SKIPPED - ORI_FC_KERNEL is not set or the file does not exist");
  process.exit(0);
}
const rootfs = process.env.ORI_FC_ROOTFS;
if (!rootfs || !(await pathExists(rootfs))) {
  console.log("e2e-fc-bench: SKIPPED - ORI_FC_ROOTFS is not set or the file does not exist");
  process.exit(0);
}
const agentBinary = process.env.ORI_FC_AGENT_BINARY;
if (!agentBinary || !(await pathExists(agentBinary))) {
  console.log("e2e-fc-bench: SKIPPED - ORI_FC_AGENT_BINARY is not set or the file does not exist");
  process.exit(0);
}

let step = 0;
function ok(msg: string): void {
  step += 1;
  console.log(`  ✓ ${String(step).padStart(2)} ${msg}`);
}

let stateDir: string | null = null;
let driver: FirecrackerMachineDriver | null = null;
let created: CreatedMachine | null = null;
const bootMs: number[] = [];
const snapshotMs: number[] = [];
const memBytes: number[] = [];
const resumeMs: number[] = [];

try {
  stateDir = await mkdtemp(join(tmpdir(), "ori-fc-bench-"));
  driver = new FirecrackerMachineDriver({ stateDir });

  const oriId = `or_${randomBytes(6).toString("hex")}`;
  const machineToken = randomBytes(24).toString("hex");
  const agentToken = randomBytes(24).toString("hex");

  const bootStart = Date.now();
  created = await driver.create({ oriId, type: "nano", image: rootfs, machineToken, agentToken });
  const machineId = created.machineId;
  if (!(await waitHealthy(created.ip, agentToken, 90_000))) {
    throw new Error(`guest agent at ${created.ip}:7777 never became healthy`);
  }
  bootMs.push(Date.now() - bootStart);
  ok(`booted in ${bootMs[0]} ms (${oriId} -> ${machineId} at ${created.ip})`);

  const guest = GuestClient.forIp(created.ip, agentToken);

  const marker = (await guest.exec({ command: MARKER, timeoutSeconds: 10 })) as unknown as ExecOut;
  if (!marker.success) throw new Error(`counter start failed: ${marker.stderr || marker.stdout}`);
  const counterPid = marker.stdout.trim();
  ok(`counter process started in guest (pid ${counterPid})`);

  await Bun.sleep(2500);
  let lastCount = await readCounter(guest);
  ok(`counter baseline: count=${lastCount}`);

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const stopStart = Date.now();
    await driver.stop(machineId);
    snapshotMs.push(Date.now() - stopStart);

    const metadata = await readMachineMetadata(stateDir!, machineId);
    const mem = metadata?.memFileBytes;
    if (mem == null) throw new Error(`metadata for ${machineId} has no memFileBytes after stop`);
    memBytes.push(mem);
    ok(`cycle ${cycle}: snapshot in ${snapshotMs[snapshotMs.length - 1]} ms, mem ${mem} bytes`);

    const resumeStart = Date.now();
    await driver.start(machineId);
    if (!(await waitHealthy(created.ip, agentToken, 30_000))) {
      throw new Error(`guest agent at ${created.ip}:7777 did not come back after resume`);
    }
    resumeMs.push(Date.now() - resumeStart);
    ok(`cycle ${cycle}: resumed in ${resumeMs[resumeMs.length - 1]} ms`);

    // The counter ticks once a second and the guest just woke — poll rather than read
    // instantly, or a 177ms resume gets punished for being faster than the counter.
    let count = lastCount;
    const advanceDeadline = Date.now() + 5000;
    while (Date.now() < advanceDeadline) {
      count = await readCounter(guest);
      if (count > lastCount) break;
      await Bun.sleep(300);
    }
    if (!(count > lastCount)) {
      throw new Error(`counter did not advance after resume: ${lastCount} -> ${count} (guest rebooted?)`);
    }
    const alive = (await guest.exec({ command: `kill -0 ${counterPid} && echo ALIVE`, timeoutSeconds: 10 })) as unknown as ExecOut;
    if (!alive.stdout.trim().includes("ALIVE")) {
      throw new Error(`counter pid ${counterPid} is not alive after resume`);
    }
    ok(`cycle ${cycle}: counter survived, count ${lastCount} -> ${count}, pid ${counterPid} alive`);

    const guestEpoch = Number(
      ((await guest.exec({ command: "date +%s", timeoutSeconds: 10 })) as unknown as ExecOut).stdout.trim(),
    );
    const clockDeltaMs = Math.abs(guestEpoch * 1000 - Date.now());
    if (clockDeltaMs > 5000) {
      throw new Error(
        `guest clock not stepped: guest=${guestEpoch}, host=${Math.floor(Date.now() / 1000)} (${clockDeltaMs} ms off)`,
      );
    }
    ok(`cycle ${cycle}: guest clock stepped (${clockDeltaMs} ms from host)`);

    lastCount = count;
  }

  const medResume = median(resumeMs);
  const medSnapshot = median(snapshotMs);
  const mem = median(memBytes);

  console.log("\n=== e2e-fc-bench results ===");
  console.log(`  BOOT_MS               ${bootMs[0]}`);
  console.log(`  SNAPSHOT_MS (median)  ${medSnapshot}`);
  console.log(`  mem bytes             ${mem}`);
  console.log(`  RESUME_MS (median)    ${medResume}`);
  console.log(
    `  RESUME_MS min/med/max ${Math.min(...resumeMs)} / ${medResume} / ${Math.max(...resumeMs)}  (per cycle: ${resumeMs.join(", ")})`,
  );

  const budget = Number(process.env.ORI_FC_RESUME_BUDGET_MS ?? 1000);
  const over = medResume > budget;
  console.log(
    `\ne2e-fc-bench: ${over ? "FAIL" : "PASS"} — median RESUME_MS ${medResume} ms ${over ? ">" : "<="} budget ${budget} ms`,
  );
  if (over) process.exitCode = 1;
} catch (err) {
  console.error(`\ne2e-fc-bench: FAIL — ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  if (driver && created) {
    await driver.destroy(created.machineId).catch(() => {});
  }
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
}

async function readCounter(client: GuestClient): Promise<number> {
  const file = await client.readFile(COUNTER_PATH, "utf8");
  const lines = file.content.trim().split("\n").filter(Boolean);
  const count = Number(lines[lines.length - 1]?.split(" ")[1]);
  if (!Number.isFinite(count)) throw new Error(`counter file unreadable: ${JSON.stringify(file.content)}`);
  return count;
}
