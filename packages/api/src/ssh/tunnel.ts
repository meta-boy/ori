/**
 * SSH over the control plane, so `ori ssh` works from anywhere the API does.
 *
 * The docker driver publishes a ori's sshd on the control-plane host's LOOPBACK, which is
 * correct and unreachable: a CLI on a laptop was handed `127.0.0.1:<port>`, dialled its own
 * loopback and got "connection refused" against a healthy ori. Publishing those ports on a
 * routable interface instead would mean every sandbox's sshd exposed on the host's network,
 * a port per ori, plus a way for the control plane to know which of its addresses the client
 * can actually route to — and it still would not work through a tunnel, which is how a
 * self-hosted control plane is usually reached.
 *
 * So the bytes go through the one endpoint every logged-in CLI can already reach and
 * authenticate to: this server. The CLI opens a WebSocket here with its API key, this end
 * opens a TCP connection to the ori's published sshd, and the two are spliced. SSH's own
 * cryptography runs end to end inside that pipe — the tunnel is a transport, it authenticates
 * *access to the machine* and never sees the session.
 *
 * Consequences worth stating:
 *   - sshd stays on loopback. Nothing new is exposed.
 *   - It works through Cloudflare/tailscale/any HTTPS reverse proxy that passes WebSockets.
 *   - The API key becomes sufficient to reach a ori's sshd, which it already was: the same key
 *     can authorise an ssh public key on the ori through POST /oris/{id}/sshkey.
 */
import { and, eq, isNull } from "drizzle-orm";
import { apiKeySecretRegex, sha256Hex } from "@ori/contract";
import { apiKeys, oris } from "../db/schema";
import type { AppDeps } from "../context";

/**
 * `/api/ori/v1/oris/{oriId}/ssh-tunnel` — the only path this handler owns.
 *
 * The id pattern is the real one from OriIdSchema (Crockford-ish base32, eight characters), not
 * a loose `[a-z0-9]+`: this runs BEFORE Hono and its validation, so a malformed id should fall
 * through as "not my path" rather than reach a database lookup.
 */
const PATH = /^\/api\/ori\/v1\/oris\/(or_[23456789abcdefghjkmnpqrstuvwxyz]{8})\/ssh-tunnel$/;

export interface TunnelData {
  host: string;
  port: number;
  /** Bun's TCP socket, attached on open. */
  sock?: { write: (d: Uint8Array | string) => number; end: () => void };
  /** Bytes the client sent before the TCP socket finished connecting. */
  pending: Uint8Array[];
}

type Upgradable = { upgrade: (req: Request, opts?: { data: TunnelData }) => boolean };

/** Resolve a bearer key to its user, or null. Mirrors authMiddleware's key path exactly. */
async function userForKey(deps: AppDeps, req: Request): Promise<string | null> {
  const header = req.headers.get("authorization");
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  // Also accept the token as a query parameter: a WebSocket opened from a browser cannot set
  // headers. The CLI uses the header; this exists so the dashboard could use the same tunnel.
  const fromQuery = new URL(req.url).searchParams.get("token");
  const secret = token ?? fromQuery ?? "";
  if (!apiKeySecretRegex.test(secret)) return null;

  const key = await deps.db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.hash, sha256Hex(secret)), isNull(apiKeys.revokedAt)),
  });
  return key?.userId ?? null;
}

export function createSshTunnel(deps: AppDeps) {
  return {
    handles(url: URL): boolean {
      return PATH.test(url.pathname);
    },

    /**
     * Returns a Response on refusal, or undefined once Bun owns the socket.
     *
     * Every refusal is deliberately terse and identical in shape: this endpoint is reachable
     * by anyone who can reach the API, so it must not become an oracle for which ori ids exist.
     */
    async fetch(req: Request, srv: Upgradable): Promise<Response | undefined> {
      const url = new URL(req.url);
      const oriId = url.pathname.match(PATH)?.[1];
      if (!oriId) return new Response("not found", { status: 404 });

      const userId = await userForKey(deps, req);
      if (!userId) return new Response("unauthorized", { status: 401 });

      const row = await deps.db.query.oris.findFirst({
        where: and(eq(oris.id, oriId), eq(oris.userId, userId)),
      });
      if (!row) return new Response("not found", { status: 404 });
      if (!row.machineId) return new Response("machine not running", { status: 409 });

      const driver = deps.driver as {
        sshAddress?: (m: string) => Promise<{ host: string; port: number } | null>;
      };
      if (typeof driver.sshAddress !== "function") {
        return new Response("driver has no ssh address", { status: 501 });
      }
      const addr = await driver.sshAddress(row.machineId);
      if (!addr) return new Response("machine not running", { status: 409 });

      const upgraded = srv.upgrade(req, { data: { host: addr.host, port: addr.port, pending: [] } });
      if (!upgraded) return new Response("expected a websocket upgrade", { status: 426 });
      return undefined;
    },

    websocket: {
      async open(ws: { data: TunnelData; send: (d: Uint8Array) => void; close: (c?: number, r?: string) => void }) {
        try {
          const sock = await Bun.connect({
            hostname: ws.data.host,
            port: ws.data.port,
            socket: {
              data(_s: unknown, chunk: Uint8Array) {
                ws.send(chunk);
              },
              // sshd hanging up must close the WebSocket, or the CLI waits forever on a dead pipe.
              close() {
                ws.close(1000, "ssh closed");
              },
              error() {
                ws.close(1011, "ssh error");
              },
            },
          });
          ws.data.sock = sock as unknown as TunnelData["sock"];
          // SSH speaks first from the server, but a client that got its bytes in before the
          // TCP connect resolved would otherwise lose them silently.
          for (const chunk of ws.data.pending) ws.data.sock!.write(chunk);
          ws.data.pending.length = 0;
        } catch {
          ws.close(1011, "could not reach sshd");
        }
      },

      message(ws: { data: TunnelData }, message: string | Uint8Array) {
        const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
        if (ws.data.sock) ws.data.sock.write(bytes);
        else ws.data.pending.push(bytes);
      },

      close(ws: { data: TunnelData }) {
        try {
          ws.data.sock?.end();
        } catch {
          // Already gone; nothing to do.
        }
      },
    },
  };
}
