import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { hostEnvFromProcess, hostHide, hostList, hostPort, hostUrl } from "@ori/guest-agent/host";

/**
 * T-P12-09 — the in-box `host` CLI talks to the control plane's machine-token internal
 * routes API. A stub control plane records the requests (auth, body) and answers like the
 * real one, so the module's URL/token plumbing is exercised without a full server.
 */

let server: { url: string; stop(): void };
const seen: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];

beforeAll(async () => {
  const s = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === "POST" || req.method === "PUT" || req.method === "DELETE"
        ? (await req.json().catch(() => null))
        : null;
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body });
      const auth = req.headers.get("authorization");
      if (auth !== "Bearer ori_mt_deadbeef") {
        return Response.json({ ok: false, type: "ori.error", status: 401, code: "unauthorized", message: "Unauthorized" }, { status: 401 });
      }
      if (req.method === "POST" && url.pathname.endsWith("/routes")) {
        const { port } = body as { port: number };
        const hostname = `or-abc-${port}.on.ori.dev`;
        return Response.json({
          ok: true, type: "route.registered",
          oriId: "or_12345678", port, hostname,
          url: `https://${hostname}`,
          access: (body as { public?: boolean }).public ? "public" : "private",
          isProtected: !(body as { public?: boolean }).public,
          title: null,
          token: (body as { public?: boolean }).public ? null : "tok123",
        });
      }
      if (req.method === "GET" && url.pathname.endsWith("/routes")) {
        return Response.json({ ok: true, type: "route.list", routes: [
          { port: 3000, hostname: "or-abc-3000.on.ori.dev", url: "https://or-abc-3000.on.ori.dev", access: "private", isProtected: true, title: null, token: "tok123" },
        ] });
      }
      if (req.method === "DELETE") {
        return Response.json({ ok: true, type: "route.removed", oriId: "or_12345678" });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  });
  server = { url: `http://127.0.0.1:${(s as { port: number }).port}`, stop: () => s.stop(true) };
  process.env.ORI_ID = "or_12345678";
  process.env.ORI_MACHINE_TOKEN = "ori_mt_deadbeef";
  process.env.ORI_CONTROL_PLANE = server.url;
});

afterAll(() => {
  server.stop();
  delete process.env.ORI_ID;
  delete process.env.ORI_MACHINE_TOKEN;
  delete process.env.ORI_CONTROL_PLANE;
});

describe("T-P12-09 guest host module", () => {
  test("hostEnvFromProcess reads the driver-written env", () => {
    const env = hostEnvFromProcess();
    expect(env?.oriId).toBe("or_12345678");
    expect(env?.machineToken).toBe("ori_mt_deadbeef");
    expect(env?.controlPlane).toBe(server.url);
  });

  test("hostPort registers a port and returns the URL + token", async () => {
    const env = hostEnvFromProcess()!;
    const route = await hostPort(env, 3000, "preview", false);
    expect(route.url).toBe("https://or-abc-3000.on.ori.dev");
    expect(route.token).toBe("tok123");
    expect(route.isProtected).toBe(true);
    const call = seen[seen.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/internal/oris/or_12345678/routes");
    expect(call.auth).toBe("Bearer ori_mt_deadbeef");
    expect(call.body).toEqual({ port: 3000, title: "preview", public: false });
  });

  test("hostUrl returns an existing route without re-registering", async () => {
    const env = hostEnvFromProcess()!;
    const before = seen.length;
    const route = await hostUrl(env, 3000);
    expect(route.port).toBe(3000);
    expect(seen.length).toBe(before + 1); // one GET, no POST
    expect(seen[seen.length - 1].method).toBe("GET");
  });

  test("hostHide deletes the route", async () => {
    const env = hostEnvFromProcess()!;
    await hostHide(env, 3000);
    const call = seen[seen.length - 1];
    expect(call.method).toBe("DELETE");
    expect(call.path).toBe("/internal/oris/or_12345678/routes/3000");
  });
});
