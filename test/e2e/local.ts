/**
 * T-P4-09 — local end-to-end against REAL Docker containers.
 *
 * Everything else in the suite drives the fake driver. This is the only check that a ori
 * is a real machine: that a container boots systemd, that the guest agent comes up inside
 * it, and that bytes written through the public HTTP API land on that container's disk.
 *
 * It asserts behaviour, not shapes. `uname -a` really has to say Linux; a file written
 * through PUT /files is read back by `cat` through POST /commands, not by trusting the
 * API's own echo of what it thinks it wrote.
 *
 * Deliberately NOT here, because the endpoints do not exist yet: snapshot/resume data
 * survival and package/unit survival (P5), fork independence with real data (P5), resize
 * and type_too_small (needs P5 restore), port hosting (P6), SSH (P7), desktop (P8).
 * P5-12 owns the survival flow.
 *
 * Run with `make e2e-local`. Needs Docker and the ori-base:latest image.
 */
const PG_CONTAINER = process.env.PGC ?? "ori-postgres-1";
const RUN = `e2e_${process.pid}`;
const DB_NAME = `ori_${RUN}`;
const BASE = "/api/ori/v1";

let step = 0;
function ok(msg: string): void {
  step += 1;
  console.log(`  ✓ ${String(step).padStart(2)} ${msg}`);
}
function fail(msg: string): never {
  throw new Error(msg);
}

async function sh(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

async function psql(sql: string): Promise<void> {
  await sh(["docker", "exec", "-i", PG_CONTAINER, "psql", "-U", "ori", "-d", "ori", "-q", "-c", sql]);
}

// ---------------------------------------------------------------------------
// Preflight. Skip (exit 0) rather than fail when the machine cannot run this.
// ---------------------------------------------------------------------------
if ((await sh(["docker", "version", "--format", "{{.Server.Version}}"])).code !== 0) {
  console.log("e2e-local: SKIPPED — docker is not available");
  process.exit(0);
}
const img = await sh(["docker", "image", "inspect", "ori-base:latest", "-f", "{{.Id}}"]);
if (img.code !== 0) {
  console.log("e2e-local: SKIPPED — ori-base:latest not built. Run image/build-docker.sh first.");
  process.exit(0);
}
if ((await sh(["docker", "inspect", "-f", "{{.State.Running}}", PG_CONTAINER])).out.trim() !== "true") {
  console.log(`e2e-local: SKIPPED — postgres container ${PG_CONTAINER} is not running (docker compose up -d)`);
  process.exit(0);
}

console.log(`e2e-local: database ${DB_NAME}, real Docker driver\n`);

// Own database per run, so a concurrent `make test` or another agent cannot collide.
await psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
await psql(`CREATE DATABASE ${DB_NAME}`);
process.env.DATABASE_URL = `postgres://ori:ori@localhost:5432/${DB_NAME}`;

// Imports are dynamic and come AFTER DATABASE_URL is set: the db client reads it at
// module load, so a static import would bind to the shared dev database.
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { postgresClient } = await import("@ori/api/db/client");
const schema = await import("@ori/api/db/schema");
const migSql = postgresClient(process.env.DATABASE_URL);
await migrate(drizzle(migSql, { schema }), {
  migrationsFolder: new URL("../../packages/api/drizzle", import.meta.url).pathname,
});
await migSql.end();

const { createApp } = await import("@ori/api/app");
const { makeDb } = await import("@ori/api/db/client");
const { TokenStore } = await import("@ori/api/tokens");
const { DockerMachineDriver } = await import("@ori/api/drivers/docker");
const { seedUserKey } = await import("../api/helpers");

const db = makeDb();
const driver = new DockerMachineDriver();
const app = createApp({ db, driver, tokens: new TokenStore() });
const key = await seedUserKey(db);
const auth = { authorization: `Bearer ${key.secret}`, "content-type": "application/json" };

let oriIdCreated: string | null = null;
let machineId: string | null = null;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(`${BASE}${path}`, {
    method,
    headers: auth,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function exec(command: string): Promise<any> {
  const r = await api("POST", `/oris/${oriIdCreated}/commands`, { command, timeoutSeconds: 30 });
  if (r.status !== 200) fail(`exec ${command}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

try {
  // 1. create ------------------------------------------------------------------
  const created = await api("POST", "/oris", { ttlSeconds: 3600 });
  if (created.status !== 202) fail(`create: HTTP ${created.status} ${JSON.stringify(created.json)}`);
  oriIdCreated = created.json.ori.id;
  if (!/^or_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(oriIdCreated!)) fail(`bad ori id ${oriIdCreated}`);
  ok(`created ${oriIdCreated} (state ${created.json.ori.state})`);

  // 2. reach ready -------------------------------------------------------------
  const deadline = Date.now() + 120_000;
  let state = created.json.ori.state;
  while (Date.now() < deadline) {
    const got = await api("GET", `/oris/${oriIdCreated}`);
    state = got.json.ori.state;
    if (state === "ready") break;
    if (state === "error") fail("ori went to error while provisioning");
    await Bun.sleep(500);
  }
  if (state !== "ready") fail(`ori never reached ready (stuck in ${state})`);
  const row = await db.query.oris.findFirst({ where: (b: any, { eq }: any) => eq(b.id, oriIdCreated) });
  machineId = row?.machineId ?? null;
  ok(`reached ready, machine ${machineId}`);

  // 3. it is a real Linux machine ---------------------------------------------
  const uname = await exec("uname -a");
  if (uname.exitCode !== 0 || !uname.stdout.includes("Linux")) {
    fail(`uname did not report Linux: ${JSON.stringify(uname).slice(0, 300)}`);
  }
  ok(`uname -a -> ${uname.stdout.trim().slice(0, 60)}`);

  // 4. the toolchain the image promises is actually there ---------------------
  const tools = await exec("id -u user && command -v docker git rg jq restic bun && systemctl is-active ssh.socket");
  if (tools.exitCode !== 0) fail(`preinstalled tools missing: ${tools.stdout} ${tools.stderr}`);
  ok("user, docker, git, rg, jq, restic, bun present; ssh.socket active");

  // 5. PUT a utf8 file through the public API ---------------------------------
  const text = "hello from the api ünicode\n";
  const put = await api("PUT", `/oris/${oriIdCreated}/files`, { path: "e2e/hello.txt", content: text });
  if (put.status !== 200 || put.json.type !== "file.written") fail(`PUT files: ${JSON.stringify(put.json)}`);
  ok(`PUT /files e2e/hello.txt (${put.json.size} bytes)`);

  // 6. GET it back -------------------------------------------------------------
  const get = await api("GET", `/oris/${oriIdCreated}/files?path=e2e%2Fhello.txt`);
  if (get.json.content !== text) fail(`GET files mismatch: ${JSON.stringify(get.json.content)}`);
  ok("GET /files returns the same bytes");

  // 7. and prove they are on the CONTAINER's disk, not just in the API --------
  const cat = await exec("cat /home/user/e2e/hello.txt");
  if (cat.stdout !== text) fail(`cat inside the ori disagrees: ${JSON.stringify(cat.stdout)}`);
  ok("cat inside the container agrees — the write really landed on disk");

  // 7b. the login user can actually USE what the API created -------------------
  // The agent is root, so for a while everything it made in /home/user came out root-owned:
  // a file uploaded through PUT /files was mode 0600 root:root and the user who ssh'd in got
  // "Permission denied" reading their own upload, and `ori exec` left files they could not
  // edit. The unit tests cannot catch this — the suite runs unprivileged, so writer and home
  // owner are the same account there and the assertion is vacuous. It has to be checked
  // where the agent is really root, which is here.
  const owner = await exec(
    "stat -c '%U:%G' /home/user/e2e/hello.txt /home/user/e2e && id -un && echo HOME=$HOME",
  );
  const lines = owner.stdout.trim().split("\n");
  if (lines[0] !== "user:user") fail(`an uploaded file is ${lines[0]}, not user:user — the ssh user cannot read it`);
  if (lines[1] !== "user:user") fail(`a directory the upload created is ${lines[1]}, not user:user`);
  if (lines[2] !== "user") fail(`exec runs as ${lines[2]}, not the login user — files it writes will be root-owned`);
  if (lines[3] !== "HOME=/home/user") fail(`exec has ${lines[3]}, expected HOME=/home/user`);
  // The end-to-end property, not a proxy for it: the account exec runs as — which is now the
  // same account ssh lands in — must be able to modify the upload. Written to its own path so
  // this does not disturb the artifact assertions below, which read e2e/ back.
  await api("PUT", `/oris/${oriIdCreated}/files`, { path: "own/mine.txt", content: "from the api\n" });
  const canEdit = await exec("echo appended >> /home/user/own/mine.txt && echo WRITABLE");
  if (!canEdit.stdout.includes("WRITABLE")) fail(`the login user cannot modify an uploaded file: ${canEdit.stderr}`);
  ok("exec runs as `user`, uploads are user-owned, and the ssh account can edit them");

  // 8. binary round-trip, byte-exact ------------------------------------------
  const bin = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80]);
  const b64 = Buffer.from(bin).toString("base64");
  await api("PUT", `/oris/${oriIdCreated}/files`, { path: "e2e/bin.dat", content: b64, encoding: "base64" });
  const gotBin = await api("GET", `/oris/${oriIdCreated}/files?path=e2e%2Fbin.dat&encoding=base64`);
  if (gotBin.json.content !== b64) fail(`binary round-trip corrupted: ${b64} -> ${gotBin.json.content}`);
  const hexIn = Buffer.from(bin).toString("hex");
  // od, not xxd: xxd ships with vim-common and is not in the image. od is coreutils.
  const hexOri = (await exec("od -An -v -tx1 /home/user/e2e/bin.dat | tr -d ' \\n'")).stdout.trim();
  if (hexOri !== hexIn) fail(`bytes on disk differ: expected ${hexIn}, ori has ${hexOri || "(empty)"}`);
  ok(`binary byte-exact through the API and on disk (${hexIn})`);

  // 9. artifacts: single file --------------------------------------------------
  const artRes = await app.request(`${BASE}/oris/${oriIdCreated}/artifacts?path=e2e%2Fhello.txt`, { headers: auth });
  if (artRes.status !== 200) fail(`artifacts file: HTTP ${artRes.status}`);
  if ((await artRes.text()) !== text) fail("artifacts file bytes differ");
  ok("GET /artifacts streams the single file");

  // 10. artifacts: folder as tar ----------------------------------------------
  const tarRes = await app.request(`${BASE}/oris/${oriIdCreated}/artifacts?path=e2e`, { headers: auth });
  if (tarRes.status !== 200) fail(`artifacts folder: HTTP ${tarRes.status}`);
  const tarBytes = new Uint8Array(await tarRes.arrayBuffer());
  if (tarBytes.length < 512) fail(`tar too small (${tarBytes.length} bytes)`);
  // A tar's first 100 bytes are the first entry's NUL-padded name.
  // `?? []` on a match result infers never[], which makes includes() unusable.
  const names: string[] = new TextDecoder().decode(tarBytes).match(/(hello\.txt|bin\.dat)/g) ?? [];
  if (!names.includes("hello.txt") || !names.includes("bin.dat")) {
    fail(`tar missing entries, found ${JSON.stringify(names)}`);
  }
  ok(`GET /artifacts streams the folder as tar (${tarBytes.length} bytes, both entries present)`);

  // 11. stop -------------------------------------------------------------------
  // 202, not 200: archiving is asynchronous, so stop acknowledges and the ori reaches
  // `archived` afterwards. Same for create.
  const stop = await api("POST", `/oris/${oriIdCreated}/stop`, { force: true });
  if (stop.status !== 202 || stop.json.status !== "archiving") {
    fail(`stop: HTTP ${stop.status} ${JSON.stringify(stop.json)}`);
  }
  const stopDeadline = Date.now() + 60_000;
  let finalState = "";
  while (Date.now() < stopDeadline) {
    finalState = (await api("GET", `/oris/${oriIdCreated}`)).json.ori.state;
    if (finalState === "archived") break;
    await Bun.sleep(500);
  }
  if (finalState !== "archived") fail(`ori never archived (stuck in ${finalState})`);
  ok("POST /stop -> archived");

  // 12. warm tier: the container survives stop, halted --------------------------
  const warm = await sh(["docker", "inspect", "-f", "{{.State.Running}}", machineId!]);
  if (warm.code !== 0) fail(`container ${machineId} gone after stop — warm tier should keep it`);
  if (warm.out.trim() !== "false") fail(`container still running after stop (${warm.out.trim()})`);
  ok("container kept on disk, halted (warm)");

  // 13. warm resume: starts in place, fast, with the disk intact ----------------
  const resumeStart = Date.now();
  const resume = await api("POST", `/oris/${oriIdCreated}/resume`, {});
  if (resume.status !== 202) {
    // The 500 body is generic; the row and event carry the real driver error.
    const errRow = await db.query.oris.findFirst({ where: (b: any, { eq }: any) => eq(b.id, oriIdCreated) });
    fail(`resume: HTTP ${resume.status} ${JSON.stringify(resume.json)} — ori.error=${errRow?.error ?? "none"}`);
  }
  const resumeDeadline = Date.now() + 60_000;
  let resumedState = "";
  while (Date.now() < resumeDeadline) {
    resumedState = (await api("GET", `/oris/${oriIdCreated}`)).json.ori.state;
    if (resumedState === "ready" || resumedState === "error") break;
    await Bun.sleep(250);
  }
  const warmResumeMs = Date.now() - resumeStart;
  if (resumedState !== "ready") fail(`warm resume never reached ready (${resumedState})`);
  // The warm budget is "docker start + agent health", seconds — not the minutes a restic
  // restore takes. 15s is generous; the point is catching a silent fall-through to cold.
  if (warmResumeMs > 15_000) fail(`warm resume took ${warmResumeMs}ms — smells like the cold path`);
  const survived = await api("GET", `/oris/${oriIdCreated}/files?path=e2e%2Fhello.txt`);
  if (survived.status !== 200) fail(`file lost across warm resume: HTTP ${survived.status}`);
  ok(`warm resume in ${warmResumeMs}ms, disk intact`);

  // 14. delete reclaims the warm container --------------------------------------
  // Delete requires archived (ori_not_deletable on a ready ori), so stop again first —
  // which also proves the warm tier survives a second stop cycle.
  const restop = await api("POST", `/oris/${oriIdCreated}/stop`, { force: true });
  if (restop.status !== 202) fail(`re-stop: HTTP ${restop.status} ${JSON.stringify(restop.json)}`);
  const restopDeadline = Date.now() + 60_000;
  let restopState = "";
  while (Date.now() < restopDeadline) {
    restopState = (await api("GET", `/oris/${oriIdCreated}`)).json.ori.state;
    if (restopState === "archived") break;
    await Bun.sleep(500);
  }
  if (restopState !== "archived") fail(`second stop never archived (${restopState})`);
  const del = await api("DELETE", `/oris/${oriIdCreated}`);
  if (del.status !== 200) fail(`delete: HTTP ${del.status} ${JSON.stringify(del.json)}`);
  const gone = await sh(["docker", "inspect", "-f", "{{.Id}}", machineId!]);
  if (gone.code === 0) fail(`container ${machineId} still exists after delete`);
  machineId = null;
  ok("delete reclaimed the warm container");

  console.log("\ne2e-local: PASS");
} catch (err) {
  console.error(`\ne2e-local: FAIL — ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  // Unconditional. A leaked container keeps running (and in production, billing) forever,
  // and a leaked database accumulates until something else trips over it.
  if (machineId) {
    await sh(["docker", "rm", "-f", machineId]);
    console.log(`  cleanup: removed container ${machineId}`);
  }
  try {
    await db.$client?.end?.();
  } catch {
    /* best effort */
  }
  await psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  console.log(`  cleanup: dropped ${DB_NAME}`);
}
