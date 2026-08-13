import { describe, expect, test } from "bun:test";
import { CaddyAdminClient, NoopRegistrar } from "@ori/api/edge/registrar";

/**
 * The Caddy admin client is the one piece of hosting that only runs on a real deployment, so
 * it is the piece most likely to ship broken. A fake `fetch` standing in for the admin API
 * proves the shape of what we send: the gate points at THIS control plane (not at Caddy's own
 * admin port, which is what string-mangling the admin URL used to produce), the route lands at
 * index 0 with its @id handle, and the Etag conflict retry actually retries.
 */

interface Call {
  method: string;
  path: string;
  ifMatch: string | null;
  body: unknown;
}

function fakeCaddy(plan: (call: Call, n: number) => Response): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: new URL(String(url)).pathname,
      ifMatch: new Headers(init?.headers).get("if-match"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return plan(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const SERVERS = { srv0: { listen: [":443"] }, srvInternal: { listen: [":2019"] } };

function serversResponse(): Response {
  return new Response(JSON.stringify(SERVERS), { headers: { "content-type": "application/json" } });
}

describe("CaddyAdminClient", () => {
  test("gated route dials the control plane for validate, and the ori for traffic", async () => {
    const { calls, fetchImpl } = fakeCaddy((call) => {
      if (call.path.endsWith("/servers")) return serversResponse();
      if (call.method === "GET") return new Response("{}", { headers: { etag: "v1" } });
      return new Response("", { status: 200 });
    });
    const client = new CaddyAdminClient("http://localhost:2019", "127.0.0.1:8787", fetchImpl);
    await client.addRoute({ hostname: "orabc-3000.on.ori.dev", dial: "10.10.0.5:3000", gate: true });

    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/config/apps/http/servers/srv0/routes/0");
    expect(put.ifMatch).toBe("v1");
    const route = put.body as { "@id": string; handle: Array<{ upstreams: { dial: string }[]; rewrite?: { uri: string } }> };
    expect(route["@id"]).toBe("orabc-3000.on.ori.dev");
    // First handler = the forward_auth gate, pointed at the control plane's validate endpoint.
    expect(route.handle[0].upstreams[0].dial).toBe("127.0.0.1:8787");
    expect(route.handle[0].rewrite?.uri).toBe("/internal/edge/validate");
    // Second = the ori itself.
    expect(route.handle[1].upstreams[0].dial).toBe("10.10.0.5:3000");
  });

  test("public route is just the ori proxy, no gate", async () => {
    const { calls, fetchImpl } = fakeCaddy((call) => {
      if (call.path.endsWith("/servers")) return serversResponse();
      if (call.method === "GET") return new Response("{}", { headers: { etag: "v1" } });
      return new Response("", { status: 200 });
    });
    const client = new CaddyAdminClient("http://localhost:2019", "127.0.0.1:8787", fetchImpl);
    await client.addRoute({ hostname: "orabc-80.on.ori.dev", dial: "10.10.0.5:80", gate: false });
    const route = calls.find((c) => c.method === "PUT")!.body as { handle: unknown[] };
    expect(route.handle).toHaveLength(1);
  });

  test("a gated route without a validate dial is refused rather than silently unguarded", async () => {
    const { fetchImpl } = fakeCaddy(() => serversResponse());
    const client = new CaddyAdminClient("http://localhost:2019", null, fetchImpl);
    await expect(client.addRoute({ hostname: "orabc-3000.on.ori.dev", dial: "10.10.0.5:3000", gate: true })).rejects.toThrow(
      /ORI_EDGE_VALIDATE_DIAL/,
    );
  });

  test("a 412 from a stale Etag is retried, not surfaced", async () => {
    let puts = 0;
    const { fetchImpl } = fakeCaddy((call) => {
      if (call.path.endsWith("/servers")) return serversResponse();
      if (call.method === "GET") return new Response("{}", { headers: { etag: `v${puts}` } });
      puts++;
      return new Response("", { status: puts === 1 ? 412 : 200 });
    });
    const client = new CaddyAdminClient("http://localhost:2019", "127.0.0.1:8787", fetchImpl);
    await client.addRoute({ hostname: "orabc-3000.on.ori.dev", dial: "10.10.0.5:3000", gate: false });
    expect(puts).toBe(2);
  });

  test("removeRoute deletes by @id and treats 404 as done", async () => {
    const { calls, fetchImpl } = fakeCaddy(() => new Response("", { status: 404 }));
    const client = new CaddyAdminClient("http://localhost:2019", "127.0.0.1:8787", fetchImpl);
    await client.removeRoute("orabc-3000.on.ori.dev");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].path).toBe("/id/orabc-3000.on.ori.dev");
  });

  test("the noop registrar says it is off", async () => {
    const noop = new NoopRegistrar();
    expect(noop.enabled).toBe(false);
    await noop.addRoute();
    await noop.removeRoute();
  });
});
