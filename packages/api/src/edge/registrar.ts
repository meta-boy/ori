/**
 * Edge route registration — the control-plane side of `host <port>`.
 *
 * A hosted service is a DB row (portRoutes: the source of truth, survives resume) plus an
 * entry in the edge proxy config (Caddy, via its admin API on localhost:2019 — the exact
 * contract in infra/edge-routes.md). The ori never holds routing credentials: it calls
 * `POST /internal/oris/:id/routes`, and this module reconciles Caddy.
 *
 * The registrar is OPTIONAL by design: the DB row and the URL are always real, but a laptop
 * or a test has no Caddy, so the edge push is behind an `enabled` flag. A deployment turns
 * it on by pointing ORI_CADDY_ADMIN_URL at the Caddy admin API; until then `ori host`
 * returns the URL (and it will not resolve). Honest, and keeps the control plane the one
 * moving part that tests can prove.
 */

/** One edge proxy route: hostname -> dial target, optionally token-gated. */
export interface RouteTarget {
  /** `<subdomain>-<port>.<EDGE_DOMAIN>` — also the Caddy @id handle. */
  hostname: string;
  /** Address the edge proxies to, e.g. `127.0.0.1:53001` or a container bridge IP. */
  dial: string;
  /** When true, requests without a valid `_token` are rejected by the edge. */
  gate: boolean;
}

export interface RouteRegistrar {
  readonly enabled: boolean;
  addRoute(target: RouteTarget): Promise<void>;
  removeRoute(hostname: string): Promise<void>;
}

/** Does nothing, says so. Used by tests and by default until a deployment enables the edge. */
export class NoopRegistrar implements RouteRegistrar {
  readonly enabled = false;
  async addRoute(): Promise<void> {}
  async removeRoute(): Promise<void> {}
}

/** Talks to Caddy's admin API per infra/edge-routes.md. */
export class CaddyAdminClient implements RouteRegistrar {
  readonly enabled: boolean;
  private serverName: string | null = null;

  /**
   * @param adminUrl    Caddy's admin API, e.g. http://localhost:2019.
   * @param validateDial `host:port` the EDGE dials to reach this control plane's
   *   /internal/edge/validate. It is not derivable from adminUrl (Caddy's admin API and the
   *   control plane are different services on different ports), so a gated route without it
   *   is a configuration error, not a default.
   */
  constructor(
    private readonly adminUrl: string,
    private readonly validateDial: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
    enabled = true,
  ) {
    this.enabled = enabled;
  }

  private async raw(method: string, path: string, body?: unknown, etag?: string | null): Promise<Response> {
    return this.fetchImpl(`${this.adminUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(etag ? { "if-match": etag } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  /**
   * Resolve the HTTPS server name once (`srv0` from the Caddyfile, but never assume the
   * adapter's naming — the contract says to read it from the listen addresses).
   */
  private async resolveServerName(): Promise<string> {
    if (this.serverName) return this.serverName;
    const res = await this.raw("GET", "/config/apps/http/servers");
    if (!res.ok) throw new Error(`caddy admin: servers read failed (HTTP ${res.status})`);
    const servers = (await res.json()) as Record<string, { listen?: string[] }>;
    const name = Object.entries(servers).find(([, s]) => s.listen?.includes(":443"))?.[0];
    if (!name) throw new Error("caddy admin: no HTTPS server (listen :443) found");
    this.serverName = name;
    return name;
  }

  /**
   * Insert the route at index 0 (before the Caddyfile's catch-all 404), with the Etag
   * conflict-retry dance the contract requires. Gated routes get the forward_auth handler
   * that sends the request to our /internal/edge/validate first.
   */
  async addRoute(target: RouteTarget): Promise<void> {
    if (!this.enabled) return;
    if (target.gate && !this.validateDial) {
      throw new Error("caddy admin: private routes need ORI_EDGE_VALIDATE_DIAL (host:port of this control plane, as the edge reaches it)");
    }
    const srv = await this.resolveServerName();
    const handle = target.gate
      ? [
          {
            handler: "reverse_proxy",
            upstreams: [{ dial: this.validateDial! }],
            rewrite: { method: "GET", uri: "/internal/edge/validate" },
            headers_up: {
              request: {
                set: {
                  "X-Forwarded-Method": ["{http.request.method}"],
                  "X-Forwarded-Uri": ["{http.request.uri}"],
                  "X-Forwarded-Host": ["{http.request.host}"],
                },
              },
            },
            handle_response: [{ match: { status_code: [2] }, routes: [{ handle: [{ handler: "vars" }] }] }],
          },
          { handler: "reverse_proxy", upstreams: [{ dial: target.dial }] },
        ]
      : [{ handler: "reverse_proxy", upstreams: [{ dial: target.dial }] }];

    const route = {
      "@id": target.hostname,
      match: [{ host: [target.hostname] }],
      terminal: true,
      handle,
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      const read = await this.raw("GET", `/config/apps/http/servers/${srv}/routes/0`);
      if (read.ok) {
        const etag = read.headers.get("etag");
        const put = await this.raw("PUT", `/config/apps/http/servers/${srv}/routes/0`, route, etag);
        if (put.ok || put.status === 409) return; // 409 = already present via @id
        if (put.status === 412) continue; // stale read; retry
        throw new Error(`caddy admin: route insert failed (HTTP ${put.status})`);
      }
      // No route at index 0 yet: POST appends.
      const post = await this.raw("POST", `/config/apps/http/servers/${srv}/routes/0`, route);
      if (post.ok || post.status === 409) return;
      throw new Error(`caddy admin: route insert failed (HTTP ${post.status})`);
    }
    throw new Error("caddy admin: route insert failed after etag conflicts");
  }

  /** Delete the route by its @id handle. */
  async removeRoute(hostname: string): Promise<void> {
    if (!this.enabled) return;
    const res = await this.raw("DELETE", `/id/${encodeURIComponent(hostname)}`);
    // 404 = nothing to remove; that is success for idempotent teardown.
    if (!res.ok && res.status !== 404) {
      throw new Error(`caddy admin: route remove failed (HTTP ${res.status})`);
    }
  }
}
