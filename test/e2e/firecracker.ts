/**
 * e2e-firecracker — REAL Firecracker microVM end-to-end.
 *
 * Everything else in the suite drives Docker (or fakes). This is the only check that the
 * Firecracker driver's story is real: a microVM boots from a kernel + rootfs, the guest
 * agent comes up inside it on :7777, and destroy tears the machine dir back down.
 *
 * Required host environment (see packages/api/src/drivers/firecracker.ts):
 *   - `firecracker` on PATH
 *   - /dev/kvm — a Linux host with KVM
 *   - ORI_FC_KERNEL        path to a vmlinux kernel image
 *   - ORI_FC_ROOTFS        path to a nano rootfs ext4 image (used for the "nano" type via
 *                          the driver's ORI_FC_ROOTFS fallback)
 *   - ORI_FC_AGENT_BINARY  path to the ori guest-agent binary (the driver hard-requires it;
 *                          documented here but not probed)
 *   - root, to create the tap and attach it to the bridge
 *
 * Any missing PROBED prerequisite prints "SKIPPED - <reason>" and exits 0, like the other
 * e2e tests: this suite must stay green on hosts that cannot run microVMs. Run with
 * `make e2e-firecracker`.
 */
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FirecrackerMachineDriver } from "@ori/api/drivers/firecracker";
import type { CreatedMachine } from "@ori/api/drivers/types";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Preflight. Skip (exit 0) rather than fail when this host cannot run a microVM.
// ---------------------------------------------------------------------------
if (!(await Bun.which("firecracker"))) {
  console.log("e2e-firecracker: SKIPPED - firecracker is not on PATH");
  process.exit(0);
}
if (!(await pathExists("/dev/kvm"))) {
  console.log("e2e-firecracker: SKIPPED - /dev/kvm is missing (needs a Linux host with KVM)");
  process.exit(0);
}
const kernel = process.env.ORI_FC_KERNEL;
if (!kernel || !(await pathExists(kernel))) {
  console.log("e2e-firecracker: SKIPPED - ORI_FC_KERNEL is not set or the file does not exist");
  process.exit(0);
}
const rootfs = process.env.ORI_FC_ROOTFS;
if (!rootfs || !(await pathExists(rootfs))) {
  console.log("e2e-firecracker: SKIPPED - ORI_FC_ROOTFS is not set or the file does not exist");
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
try {
  stateDir = await mkdtemp(join(tmpdir(), "ori-fc-e2e-"));
  driver = new FirecrackerMachineDriver({ stateDir });

  const oriId = `or_${randomBytes(6).toString("hex")}`;
  const machineToken = randomBytes(24).toString("hex");
  const agentToken = randomBytes(24).toString("hex");

  created = await driver.create({ oriId, type: "nano", image: rootfs, machineToken, agentToken });
  const machineId = created.machineId;
  ok(`created ${oriId} -> ${machineId} at ${created.ip}`);

  // Guest agent /health answers 200 only with the agent token we handed to create().
  const deadline = Date.now() + 90_000;
  let healthy = false;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${created.ip}:7777/health`, {
        headers: { authorization: `Bearer ${agentToken}` },
      });
      if (res.status === 200) {
        healthy = true;
        break;
      }
    } catch (err) {
      lastError = String(err);
    }
    await Bun.sleep(500);
  }
  if (!healthy) {
    throw new Error(
      `guest agent at ${created.ip}:7777 never became healthy${lastError ? ` (${lastError})` : ""}`,
    );
  }
  ok("guest agent /health up on :7777");

  await driver.destroy(machineId);
  created = null;
  const machineDir = join(stateDir, machineId);
  if (await pathExists(machineDir)) {
    throw new Error(`machine dir still exists after destroy: ${machineDir}`);
  }
  ok(`destroyed ${machineId}, machine dir removed`);

  console.log("\ne2e-firecracker: PASS");
} catch (err) {
  console.error(`\ne2e-firecracker: FAIL — ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  // Unconditional. A leaked microVM keeps burning host CPU (and, in production, billing).
  if (driver && created) {
    await driver.destroy(created.machineId).catch(() => {});
  }
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
}
