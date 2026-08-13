import { serve } from "bun";
import { createApp } from "./app";
import { makeDb } from "./db/client";
import { FakeMachineDriver } from "./drivers/fake";
import { DockerMachineDriver } from "./drivers/docker";
import { FirecrackerMachineDriver } from "./drivers/firecracker";
import type { MachineType } from "@ori/contract";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { TokenStore } from "./tokens";
import { start as startReaper } from "./reaper";
import { createDesktopProxy } from "./desktop/proxy";
import { createSshTunnel } from "./ssh/tunnel";
import type { MachineDriver } from "./drivers/types";
import { CaddyAdminClient, NoopRegistrar } from "./edge/registrar";

const port = Number(process.env.PORT ?? 8787);
const db = makeDb();

const FC_ROOTFS_TYPES: Record<string, MachineType> = {
  ORI_FC_ROOTFS_NANO: "nano",
  ORI_FC_ROOTFS_SMALL: "small",
  ORI_FC_ROOTFS_DEFAULT: "default",
  ORI_FC_ROOTFS_LARGE: "large",
};

function fcRootfsFromEnv(): Partial<Record<MachineType, string>> {
  const rootfs: Partial<Record<MachineType, string>> = {};
  const base = process.env.ORI_FC_ROOTFS;
  if (base) {
    for (const type of Object.values(FC_ROOTFS_TYPES)) rootfs[type] = base;
  }
  for (const [envKey, type] of Object.entries(FC_ROOTFS_TYPES)) {
    const value = process.env[envKey];
    if (value) rootfs[type] = value;
  }
  return rootfs;
}

/**
 * Probes the host for everything FirecrackerMachineDriver needs before it is constructed.
 * Returns null when usable, otherwise a human-readable reason for the failure.
 */
async function firecrackerAvailable(): Promise<string | null> {
  if (!(await Bun.which("firecracker"))) return "firecracker binary not found on PATH";
  try {
    await stat("/dev/kvm");
  } catch {
    return "/dev/kvm is not present (KVM device unavailable)";
  }
  const stateDir = process.env.ORI_FC_STATE_DIR ?? "/var/lib/ori/fc";
  try {
    await mkdir(stateDir, { recursive: true });
    const probe = Bun.file(join(stateDir, `.fc-probe-${process.pid}`));
    await probe.write("ok");
    await probe.delete();
  } catch (error) {
    return `state dir ${stateDir} is not creatable/writable: ${(error as Error).message}`;
  }
  return null;
}

/**
 * ORI_DRIVER picks what a ori actually is. It defaults to `docker`, because the fake driver
 * creates oris that do not exist: it answers every call in-process, so a server started by
 * mistake with it looks completely healthy while `ori ssh` can never work. A fake must be
 * opt-in, never the default a real deployment falls into.
 */
async function selectDriver(): Promise<MachineDriver> {
  const name = process.env.ORI_DRIVER ?? "docker";
  switch (name) {
    case "docker":
      return new DockerMachineDriver();
    case "fake":
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "ORI_DRIVER=fake — oris are simulated in-process and nothing is really running",
        }),
      );
      return new FakeMachineDriver();
    case "firecracker": {
      const reason = await firecrackerAvailable();
      if (reason) {
        console.error(
          JSON.stringify({
            level: "error",
            msg: `ORI_DRIVER=firecracker requested but unavailable: ${reason}`,
          }),
        );
        process.exit(1);
      }
      // A box that runs `docker run` creates docker0 at 172.17.0.1/16 inside itself. If the
      // guest's object-store endpoint lives in that same default subnet, restic then dials the
      // box's own docker0 instead of the host MinIO and every snapshot on that box fails — at
      // stop time, when it is closest to losing data. Warn loudly; the FC bridge gateway
      // (ORI_FC_SUBNET's .1) is the address that does not collide. See docs/DEPLOY.md.
      const guestS3 = process.env.S3_ENDPOINT_FOR_ORI ?? "";
      if (/\/\/172\.17\.\d+\.\d+[:/]/.test(guestS3)) {
        console.warn(
          JSON.stringify({
            level: "warn",
            msg: `S3_ENDPOINT_FOR_ORI=${guestS3} is on docker's default 172.17.0.0/16 — a box that runs Docker will fail to snapshot. Use the FC bridge gateway (e.g. http://172.30.0.1:9000). See docs/DEPLOY.md.`,
          }),
        );
      }
      return new FirecrackerMachineDriver({
        subnet: process.env.ORI_FC_SUBNET,
        stateDir: process.env.ORI_FC_STATE_DIR,
        bridge: process.env.ORI_FC_BRIDGE,
        kernel: process.env.ORI_FC_KERNEL,
        rootfs: fcRootfsFromEnv(),
        agentBinary: process.env.ORI_FC_AGENT_BINARY,
      });
    }
    default:
      throw new Error(`unknown ORI_DRIVER "${name}" (expected docker, fake or firecracker)`);
  }
}

const deps = {
  db,
  driver: await selectDriver(),
  tokens: new TokenStore(),
  // The edge (Caddy admin API) is optional: without ORI_CADDY_ADMIN_URL, hosted URLs are
  // tracked but not configured in any proxy — a deployment enables hosting by pointing this
  // at Caddy (infra/edge-routes.md). Noop keeps laptops and tests honest rather than
  // failing every `ori host` on a missing Caddy.
  routes: process.env.ORI_CADDY_ADMIN_URL
    ? new CaddyAdminClient(process.env.ORI_CADDY_ADMIN_URL, process.env.ORI_EDGE_VALIDATE_DIAL ?? `127.0.0.1:${port}`)
    : new NoopRegistrar(),
};
const app = createApp(deps);

// Without this nothing auto-stops, nothing is billed, and no periodic snapshot is ever
// taken — the ori would just sit there. The interval is the one clock in the system.
const stopReaper = startReaper(deps, Number(process.env.REAPER_INTERVAL_MS ?? 60_000));

// The desktop proxy must sit in FRONT of Hono: a websocket upgrade needs server.upgrade(),
// which only the raw Bun server can do. It also owns access control for the desktop, since
// x11vnc has no password of its own.
const desktop = createDesktopProxy(deps);
// Same reason as the desktop proxy: an upgrade needs the raw Bun server. This one splices the
// socket to a ori's sshd so `ori ssh` works from a laptop that cannot route to the host.
const sshTunnel = createSshTunnel(deps);

/**
 * Bun takes ONE websocket handler for the whole server, so the two upgraders share it and are
 * told apart by what `data` carries. Getting this wrong routes VNC frames into an ssh socket.
 */
const websocket = {
  open(ws: { data: unknown }) {
    return isTunnel(ws.data) ? sshTunnel.websocket.open(ws as never) : desktop.websocket.open(ws as never);
  },
  message(ws: { data: unknown }, message: string | Uint8Array) {
    return isTunnel(ws.data)
      ? sshTunnel.websocket.message(ws as never, message)
      : desktop.websocket.message(ws as never, message);
  },
  close(ws: { data: unknown }) {
    return isTunnel(ws.data) ? sshTunnel.websocket.close(ws as never) : desktop.websocket.close(ws as never);
  },
};

function isTunnel(data: unknown): boolean {
  return typeof data === "object" && data !== null && "pending" in data;
}

const server = serve({
  port,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (desktop.handles(url)) {
      const res = await desktop.fetch(req, srv as unknown as { upgrade: (r: Request, o?: unknown) => boolean });
      // undefined means the websocket upgrade was accepted and Bun owns the socket now.
      if (res) return res;
      return undefined as unknown as Response;
    }
    if (sshTunnel.handles(url)) {
      const res = await sshTunnel.fetch(req, srv as unknown as Parameters<typeof sshTunnel.fetch>[1]);
      if (res) return res;
      return undefined as unknown as Response;
    }
    return app.fetch(req, { server: srv });
  },
  websocket: websocket as never,
});

console.log(
  `ori control plane on http://localhost:${port}/api/ori/v1 (driver: ${process.env.ORI_DRIVER ?? "docker"})`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopReaper();
    server.stop();
    process.exit(0);
  });
}

export { server }; // keep alive; used by tests that want the real server