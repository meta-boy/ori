import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, buildDeps, seedUserKey } from "./helpers";
import { oris, oriEnv, oriEvents, snapshots, startsLog, usageLedger } from "@ori/api/db/schema";
import { oriId } from "@ori/contract";
import { sha256Hex } from "@ori/api/middleware/auth";
import { machineToken } from "@ori/api/tokens";
import { storageConfigFromEnv } from "@ori/api/snapshots/storageCreds";

// The endpoint side of §5's invariant. storageCreds.test.ts proves the CREDENTIAL is
// powerless outside its prefix; this proves you cannot obtain someone else's credential
// in the first place. Both halves are needed: a perfectly scoped credential is no use if
// ori A can ask for ori B's.
const deps = buildDeps();
const db = deps.db;
const app = buildApp(deps);
const INTERNAL = "/internal/oris";

async function minioUp(): Promise<boolean> {
  try {
    const c = storageConfigFromEnv();
    return (await fetch(`${c.endpoint}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
const up = await minioUp();

/** Insert a ori row directly with a known machine token. */
async function seedOri(state = "ready"): Promise<{ id: string; token: string }> {
  const id = oriId();
  const token = machineToken(id);
  await db.insert(oris).values({
    id,
    userId: user.userId,
    name: `ori ${id}`,
    state,
    type: "default",
    machineId: `m_${id}`,
    ip: "127.0.0.1:1",
    machineTokenHash: sha256Hex(token),
    ttlSeconds: 3600,
  });
  created.push(id);
  return { id, token };
}

let user: Awaited<ReturnType<typeof seedUserKey>>;
const created: string[] = [];

beforeAll(async () => {
  user = await seedUserKey(db);
});

afterAll(async () => {
  for (const id of created) {
    await db.delete(oriEvents).where(eq(oriEvents.oriId, id));
    await db.delete(snapshots).where(eq(snapshots.oriId, id));
    await db.delete(oriEnv).where(eq(oriEnv.oriId, id));
    await db.delete(usageLedger).where(eq(usageLedger.oriId, id));
    await db.delete(startsLog).where(eq(startsLog.oriId, id));
    await db.delete(oris).where(eq(oris.id, id));
  }
});

function get(id: string, token?: string) {
  return app.request(`${INTERNAL}/${id}/storage-creds`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("T-P5-02 storage-creds is reachable only by its own ori", () => {
  test("no token is 401", async () => {
    const a = await seedOri();
    expect((await get(a.id)).status).toBe(401);
  });

  test("a malformed token is 401", async () => {
    const a = await seedOri();
    expect((await get(a.id, "not-a-machine-token")).status).toBe(401);
  });

  test("an unknown but well-formed token is 401", async () => {
    const a = await seedOri();
    // A well-formed token belonging to some OTHER ori: right shape, wrong ori.
    expect((await get(a.id, machineToken(oriId()))).status).toBe(401);
  });

  test("ori A's token on ori B's path is 404, not a credential", async () => {
    const a = await seedOri();
    const b = await seedOri();
    const res = await get(b.id, a.token);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_found");
    // Nothing about ori B may leak: no prefix, no repo url, no credential.
    const text = JSON.stringify(body);
    expect(text).not.toContain(b.id);
    expect(text).not.toContain("secretAccessKey");
  });

  test("a nonexistent ori id with a valid token is 404, same shape", async () => {
    const a = await seedOri();
    const res = await get(oriId(), a.token);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  test("an API key is NOT accepted here — this is machine-token only", async () => {
    const a = await seedOri();
    // A user's API key is far more widely distributed than a machine token; if it worked
    // on the internal surface, every SDK user could mint any ori's storage credentials.
    expect((await get(a.id, user.secret)).status).toBe(401);
  });

  test("an archived ori gets no credentials", async () => {
    const a = await seedOri("archived");
    expect((await get(a.id, a.token)).status).toBe(404);
  });
});

describe.skipIf(!up)("T-P5-02 the happy path returns usable, scoped credentials", () => {
  test("its own ori gets a credential naming only itself", async () => {
    const a = await seedOri();
    const res = await get(a.id, a.token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.prefix).toBe(`oris/${a.id}/`);
    expect(body.repoUrl).toContain(`/oris/${a.id}`);
    expect(body.credentials.accessKeyId).toBeTruthy();
    expect(body.credentials.sessionToken).toBeTruthy();
    // An hour at most, per the invariant.
    expect(body.expiresInSeconds).toBeLessThanOrEqual(3600);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});
