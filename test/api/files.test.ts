import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp, makeDb, seedUserKey, FakeMachineDriver, TokenStore } from "./helpers";
import { assertValidResponse, assertErrorEnvelope } from "../contract/harness";
import { oriEnv, oris, oriEvents, snapshots, startsLog, usageLedger } from "@ori/api/db/schema";
import type { Ori } from "@ori/contract";

const db = makeDb();
const driver = new FakeMachineDriver();
const tokens = new TokenStore();
const deps = { db, driver, tokens };
const app = buildApp(deps);

let key: Awaited<ReturnType<typeof seedUserKey>>;

const ORIS = "/api/ori/v1/oris";

async function freshKey() {
  return seedUserKey(db);
}

async function create(secret = key.secret) {
  const res = await app.request(ORIS, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
  });
  const json = await res.json();
  expect(json.ok).toBe(true);
  return json.ori as Ori;
}

async function waitForState(id: string, state: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.query.oris.findFirst({ where: eq(oris.id, id) });
    if (row?.state === state) return;
    await Bun.sleep(20);
  }
  throw new Error(`ori ${id} never reached ${state}`);
}

async function getFile(id: string, path: string, encoding?: string, secret = key.secret) {
  const qs = new URLSearchParams({ path });
  if (encoding) qs.set("encoding", encoding);
  return app.request(`${ORIS}/${id}/files?${qs}`, { headers: { authorization: `Bearer ${secret}` } });
}

async function putFile(id: string, body: unknown, secret = key.secret) {
  return app.request(`${ORIS}/${id}/files`, {
    method: "PUT",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getArtifact(id: string, path: string, secret = key.secret) {
  return app.request(`${ORIS}/${id}/artifacts?path=${encodeURIComponent(path)}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
}

async function stop(id: string, secret = key.secret) {
  const res = await app.request(`${ORIS}/${id}/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(202);
}

async function deleteOri(id: string): Promise<void> {
  await db.delete(oriEvents).where(eq(oriEvents.oriId, id));
  await db.delete(snapshots).where(eq(snapshots.oriId, id));
  await db.delete(oriEnv).where(eq(oriEnv.oriId, id));
  await db.delete(usageLedger).where(eq(usageLedger.oriId, id));
  await db.delete(startsLog).where(eq(startsLog.oriId, id));
  await db.delete(oris).where(eq(oris.id, id));
}

beforeAll(async () => {
  key = await seedUserKey(db);
});

afterAll(async () => {
  await driver.stopAll();
});

describe("T-P4-06 /oris/{oriId}/files", () => {
  test("utf8 round-trip through the API", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");

    const put = await putFile(ori.id, { path: "notes.txt", content: "hello world" }, k.secret);
    expect(put.status).toBe(200);
    const putBody = await put.json();
    assertValidResponse("writeFile", putBody);
    expect(putBody.type).toBe("file.written");
    expect(putBody.path).toBe("notes.txt");
    expect(putBody.size).toBe(11);

    const get = await getFile(ori.id, "notes.txt", "utf8", k.secret);
    expect(get.status).toBe(200);
    const getBody = await get.json();
    assertValidResponse("readFile", getBody);
    expect(getBody.type).toBe("file.read");
    expect(getBody.success).toBe(true);
    expect(getBody.content).toBe("hello world");
    expect(getBody.size).toBe(11);
    await deleteOri(ori.id);
  });

  test("base64 binary round-trip is byte-exact", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 128]);
    const b64 = bytes.toString("base64");

    const put = await putFile(ori.id, { path: "bin.dat", content: b64, encoding: "base64" }, k.secret);
    expect(put.status).toBe(200);
    const putBody = await put.json();
    assertValidResponse("writeFile", putBody);
    expect(putBody.size).toBe(bytes.length);

    const get = await getFile(ori.id, "bin.dat", "base64", k.secret);
    expect(get.status).toBe(200);
    const getBody = await get.json();
    assertValidResponse("readFile", getBody);
    expect(getBody.content).toBe(b64);
    expect(Buffer.from(getBody.content as string, "base64")).toEqual(bytes);
    await deleteOri(ori.id);
  });

  test("absolute path rejected as invalid_json with a files-appropriate message", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");

    const put = await putFile(ori.id, { path: "/etc/passwd", content: "x" }, k.secret);
    expect(put.status).toBe(400);
    const putBody = await put.json();
    assertErrorEnvelope(putBody);
    expect(putBody.code).toBe("invalid_json");
    expect(putBody.message).toMatch(/path/);
    expect(putBody.message).not.toContain("skipped");

    const get = await getFile(ori.id, "/etc/passwd", "utf8", k.secret);
    expect(get.status).toBe(400);
    expect((await get.json()).code).toBe("invalid_json");
    await deleteOri(ori.id);
  });

  test("a .. path is rejected as invalid_json", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");

    const put = await putFile(ori.id, { path: "../escape.txt", content: "x" }, k.secret);
    expect(put.status).toBe(400);
    expect((await put.json()).code).toBe("invalid_json");
    await deleteOri(ori.id);
  });

  test("over-cap content rejected on write", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");

    const put = await putFile(ori.id, { path: "big.txt", content: "a".repeat(10 * 1024 * 1024 + 1) }, k.secret);
    expect(put.status).toBe(400);
    const body = await put.json();
    expect(body.code).toBe("invalid_json");
    expect(body.message).toMatch(/exceeds/i);
    await deleteOri(ori.id);
  });

  test("missing file is 404", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");

    const get = await getFile(ori.id, "nope.txt", "utf8", k.secret);
    expect(get.status).toBe(404);
    const body = await get.json();
    assertErrorEnvelope(body);
    expect(body.code).toBe("not_found");
    await deleteOri(ori.id);
  });

  test("400 machine_not_running for an archived ori", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await stop(ori.id, k.secret);
    await waitForState(ori.id, "archived");

    const res = await getFile(ori.id, "x.txt", "utf8", k.secret);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("machine_not_running");
    await deleteOri(ori.id);
  });

  test("404 for another user's ori (same shape as nonexistent)", async () => {
    const u1 = await freshKey();
    const u2 = await freshKey();
    const ori = await create(u2.secret);
    await waitForState(ori.id, "ready");

    const res = await getFile(ori.id, "x.txt", "utf8", u1.secret);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
    await deleteOri(ori.id);
  });

  test("requires auth for GET and PUT", async () => {
    const ori = await create(key.secret);
    await waitForState(ori.id, "ready");
    expect((await getFile(ori.id, "x.txt", "utf8", "")).status).toBe(401);
    expect((await putFile(ori.id, { path: "x", content: "y" }, "")).status).toBe(401);
    await deleteOri(ori.id);
  });
});

describe("T-P4-06 /oris/{oriId}/artifacts", () => {
  test("a single file streams its bytes", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await putFile(ori.id, { path: "solo.txt", content: "artifact-content" }, k.secret);

    const res = await getArtifact(ori.id, "solo.txt", k.secret);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/octet-stream/);
    expect(await res.text()).toBe("artifact-content");
    await deleteOri(ori.id);
  });

  test("a folder streams a tar", async () => {
    const k = await freshKey();
    const ori = await create(k.secret);
    await waitForState(ori.id, "ready");
    await putFile(ori.id, { path: "proj/a.txt", content: "aaa" }, k.secret);
    await putFile(ori.id, { path: "proj/b.txt", content: "bbb" }, k.secret);

    const res = await getArtifact(ori.id, "proj", k.secret);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/x-tar/);
    const body = await res.arrayBuffer();
    // tar magic: "ustar" at offset 257 of the first 512-byte header
    const head = new Uint8Array(body.slice(0, 262));
    const magic = new TextDecoder().decode(head.slice(257, 262));
    expect(magic).toBe("ustar");
    // both entries present
    const text = new TextDecoder().decode(body);
    expect(text).toContain("aaa");
    expect(text).toContain("bbb");
    await deleteOri(ori.id);
  });
});
