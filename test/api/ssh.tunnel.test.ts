import { describe, expect, test } from "bun:test";
import { createSshTunnel } from "@ori/api/ssh/tunnel";
import { oris } from "@ori/api/db/schema";
import { oriId } from "@ori/contract";
import { buildDeps, seedUserKey } from "./helpers";

/**
 * The ssh tunnel is the reason `ori ssh` works from a laptop: the driver publishes sshd on the
 * control-plane host's loopback, and the CLI splices to it through this endpoint instead of
 * dialling an address it cannot route to.
 *
 * These test the gate, not the splice — who is allowed to open a socket into a machine. The
 * data path is exercised end to end against a real container (a real ssh session, a 2MB
 * payload and piped stdin all round-trip); what belongs in a fast suite is that an
 * unauthenticated caller, a stranger's key, and a ori with no machine are all refused, and
 * that a refusal never says whether the id exists.
 */
const deps = buildDeps();
const tunnel = createSshTunnel(deps);

/** Stands in for Bun's server: records whether an upgrade was attempted. */
function fakeServer() {
  const calls: unknown[] = [];
  return {
    calls,
    upgrade(_req: Request, opts?: unknown) {
      calls.push(opts);
      return true;
    },
  };
}

function req(oriId: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/ori/v1/oris/${oriId}/ssh-tunnel`, { headers });
}

async function seedOri(userId: string, over: Partial<typeof oris.$inferInsert> = {}) {
  const id = oriId();
  await deps.db.insert(oris).values({
    id,
    userId,
    name: "tunnel",
    state: "ready",
    type: "nano",
    machineId: "deadbeef",
    machineTokenHash: "h",
    agentTokenHash: "h",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
  return id;
}

describe("ssh tunnel: who may open a socket into a machine", () => {
  test("claims only its own path", () => {
    expect(tunnel.handles(new URL("http://x/api/ori/v1/oris/or_abcdefgh/ssh-tunnel"))).toBe(true);
    expect(tunnel.handles(new URL("http://x/api/ori/v1/oris/or_abcdefgh"))).toBe(false);
    expect(tunnel.handles(new URL("http://x/dashboard"))).toBe(false);
  });

  test("no credential is 401", async () => {
    const { userId } = await seedUserKey(deps.db);
    const id = await seedOri(userId);
    const srv = fakeServer();
    const res = await tunnel.fetch(req(id), srv);
    expect(res?.status).toBe(401);
    expect(srv.calls).toHaveLength(0);
  });

  test("a stranger's key is 404 — the same answer as a ori that does not exist", async () => {
    const owner = await seedUserKey(deps.db);
    const stranger = await seedUserKey(deps.db);
    const id = await seedOri(owner.userId);
    const srv = fakeServer();

    const mine = await tunnel.fetch(req(id, { authorization: `Bearer ${stranger.secret}` }), srv);
    const absent = await tunnel.fetch(req("or_zzzzzzzz", { authorization: `Bearer ${stranger.secret}` }), srv);

    expect(mine?.status).toBe(404);
    expect(absent?.status).toBe(404);
    expect(srv.calls).toHaveLength(0);
  });

  test("a ori with no machine is 409, not a dangling upgrade", async () => {
    const { userId, secret } = await seedUserKey(deps.db);
    const id = await seedOri(userId, { machineId: null, state: "archived" });
    const srv = fakeServer();
    const res = await tunnel.fetch(req(id, { authorization: `Bearer ${secret}` }), srv);
    expect(res?.status).toBe(409);
    expect(srv.calls).toHaveLength(0);
  });

  test("the owner's key upgrades, carrying the address to splice to", async () => {
    const { userId, secret } = await seedUserKey(deps.db);
    const id = await seedOri(userId);
    const srv = fakeServer();

    // The fake driver has no sshAddress; give it one so the gate can pass.
    (deps.driver as { sshAddress?: unknown }).sshAddress = async () => ({ host: "127.0.0.1", port: 32789 });

    const res = await tunnel.fetch(req(id, { authorization: `Bearer ${secret}` }), srv);
    expect(res).toBeUndefined(); // undefined = Bun owns the socket now
    expect(srv.calls).toHaveLength(1);
    expect(srv.calls[0]).toMatchObject({ data: { host: "127.0.0.1", port: 32789 } });
  });

  test("a token in the query string works too — a browser cannot set headers on a WebSocket", async () => {
    const { userId, secret } = await seedUserKey(deps.db);
    const id = await seedOri(userId);
    (deps.driver as { sshAddress?: unknown }).sshAddress = async () => ({ host: "127.0.0.1", port: 1234 });
    const srv = fakeServer();

    const res = await tunnel.fetch(
      new Request(`http://localhost/api/ori/v1/oris/${id}/ssh-tunnel?token=${secret}`),
      srv,
    );
    expect(res).toBeUndefined();
    expect(srv.calls).toHaveLength(1);
  });
});
