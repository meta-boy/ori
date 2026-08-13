/**
 * P12-09 — the in-box `host` CLI surface: expose a service on a stable HTTPS URL.
 *
 * The guest calls the control plane's machine-token internal API
 * (`/internal/oris/:id/routes`), which registers the DB row and reconciles the edge.
 * The ori never holds edge/routing credentials — the machine token is scoped to its own
 * routes and nothing else (same channel as storage-creds).
 *
 * Env the guest needs (written by the driver into /etc/ori-agent.env):
 *   ORI_ID, ORI_MACHINE_TOKEN, ORI_CONTROL_PLANE
 */

export interface HostEnv {
  oriId: string;
  machineToken: string;
  controlPlane: string;
}

export function hostEnvFromProcess(): HostEnv | null {
  const oriId = process.env.ORI_ID;
  const machineToken = process.env.ORI_MACHINE_TOKEN;
  const controlPlane = process.env.ORI_CONTROL_PLANE;
  if (!oriId || !machineToken || !controlPlane) return null;
  return { oriId, machineToken, controlPlane };
}

export interface HostedRoute {
  port: number;
  hostname: string;
  url: string;
  access: "private" | "public";
  isProtected: boolean;
  title: string | null;
  token: string | null;
}

/** One authenticated call to the control plane's internal routes API. */
async function internal(env: HostEnv, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${env.controlPlane.replace(/\/+$/, "")}/internal/oris/${env.oriId}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.machineToken}`,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j.message) message = j.message;
    } catch {
      // non-JSON body; keep the status
    }
    throw new Error(`control plane refused route ${method} ${path}: ${message}`);
  }
  return res.json();
}

/** `host <port> [--title T] [--private|--public]` — register (or re-register) a hosted port. */
export async function hostPort(env: HostEnv, port: number, title?: string, isPublic = false): Promise<HostedRoute> {
  const body = await internal(env, "POST", "/routes", { port, title, public: isPublic });
  const r = body as Record<string, unknown>;
  return {
    port: r.port as number,
    hostname: r.hostname as string,
    url: r.url as string,
    access: r.access as "private" | "public",
    isProtected: r.isProtected as boolean,
    title: (r.title as string | null) ?? null,
    token: (r.token as string | null) ?? null,
  };
}

/** `host list` — the ori's hosted ports. */
export async function hostList(env: HostEnv): Promise<HostedRoute[]> {
  const body = (await internal(env, "GET", "/routes")) as { routes?: Record<string, unknown>[] };
  return (body.routes ?? []).map((r) => ({
    port: r.port as number,
    hostname: r.hostname as string,
    url: r.url as string,
    access: r.access as "private" | "public",
    isProtected: r.isProtected as boolean,
    title: (r.title as string | null) ?? null,
    token: (r.token as string | null) ?? null,
  }));
}

/** `host hide <port>` — take the public URL down (the local server process keeps running). */
export async function hostHide(env: HostEnv, port: number): Promise<void> {
  await internal(env, "DELETE", `/routes/${port}`);
}

/** `host url <port> [--public]` — print the full URL (registering the port first if needed). */
export async function hostUrl(env: HostEnv, port: number, isPublic = false): Promise<HostedRoute> {
  const list = await hostList(env);
  const found = list.find((r) => r.port === port);
  if (found) {
    if (isPublic && found.isProtected) {
      return hostPort(env, port, found.title ?? undefined, true);
    }
    return found;
  }
  return hostPort(env, port, undefined, isPublic);
}
