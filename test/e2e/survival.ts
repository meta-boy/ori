/**
 * T-P5-12 — does a ori's disk actually survive a stop and resume?
 *
 * This is the claim the whole snapshot subsystem exists to make, and the one thing no unit
 * test can establish: a real container is destroyed and a new one is built from a restic
 * repository in object storage, and the user's work has to still be there. Ori's promise is
 * specific (FAQ): "Files, installed packages, and enabled systemd services do [survive].
 * Hand-run processes do not." So this checks all four, including the negative.
 *
 * Then it forks and checks the fork is INDEPENDENT — writing in the fork must not change
 * the parent — because a fork that shares state is worse than no fork at all.
 *
 * Run with `make e2e-survival`. Needs Docker, ori-base:latest, postgres and minio.
 */
const PG_CONTAINER = process.env.PGC ?? "ori-postgres-1";
const DB_NAME = `ori_surv_${process.pid}`;
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

// ---- preflight: skip, never fail, when the machine cannot run this -------------------
if ((await sh(["docker", "version", "--format", "{{.Server.Version}}"])).code !== 0) {
  console.log("e2e-survival: SKIPPED — docker unavailable");
  process.exit(0);
}
if ((await sh(["docker", "image", "inspect", "ori-base:latest", "-f", "{{.Id}}"])).code !== 0) {
  console.log("e2e-survival: SKIPPED — ori-base:latest not built");
  process.exit(0);
}
if ((await sh(["docker", "inspect", "-f", "{{.State.Running}}", PG_CONTAINER])).out.trim() !== "true") {
  console.log("e2e-survival: SKIPPED — postgres not running");
  process.exit(0);
}
const S3_CP = process.env.S3_ENDPOINT ?? "http://localhost:9000";
try {
  if (!(await fetch(`${S3_CP}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok) throw new Error();
} catch {
  console.log("e2e-survival: SKIPPED — minio not reachable");
  process.exit(0);
}

// A ori reaches the object store at a DIFFERENT address than the control plane does: inside
// a container localhost is the container. Without this the guest's restic cannot reach minio
// and every snapshot fails for a reason that looks like a bug in restic.
process.env.S3_ENDPOINT_FOR_ORI ??= "http://host.docker.internal:9000";
process.env.ORI_SNAPSHOT_SECRET ??= "e2e-survival-secret";

console.log(`e2e-survival: db ${DB_NAME}, ori store ${process.env.S3_ENDPOINT_FOR_ORI}\n`);

await psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
await psql(`CREATE DATABASE ${DB_NAME}`);
process.env.DATABASE_URL = `postgres://ori:ori@localhost:5432/${DB_NAME}`;

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
const machines: string[] = [];

async function api(method: string, path: string, body?: unknown) {
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
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
}
async function exec(id: string, command: string, timeoutSeconds = 60) {
  const r = await api("POST", `/oris/${id}/commands`, { command, timeoutSeconds });
  if (r.status !== 200) fail(`exec on ${id} failed: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
}
async function waitState(id: string, want: string, ms = 180_000): Promise<void> {
  const deadline = Date.now() + ms;
  let seen = "";
  while (Date.now() < deadline) {
    seen = (await api("GET", `/oris/${id}`)).json.ori.state;
    if (seen === want) return;
    if (seen === "error") fail(`${id} went to error while waiting for ${want}`);
    await Bun.sleep(700);
  }
  fail(`${id} never reached ${want} (stuck in ${seen})`);
}
async function machineOf(id: string): Promise<string | null> {
  const row = await db.query.oris.findFirst({ where: (b: any, { eq }: any) => eq(b.id, id) });
  if (row?.machineId) machines.push(row.machineId);
  return row?.machineId ?? null;
}

const MARKER = "/home/user/survives/data.txt";
const CONTENT = "written before the stop\n";

try {
  // 1. a ori with real state on it -------------------------------------------------
  const created = await api("POST", "/oris", { ttlSeconds: 3600 });
  if (created.status !== 202) fail(`create: HTTP ${created.status} ${JSON.stringify(created.json)}`);
  const oriA = created.json.ori.id as string;
  await waitState(oriA, "ready");
  const machineA = await machineOf(oriA);
  ok(`created ${oriA}, machine ${machineA?.slice(0, 12)}`);

  await exec(oriA, `mkdir -p /home/user/survives && printf ${JSON.stringify(CONTENT)} > ${MARKER}`);
  // An enabled unit is the interesting case: the published spec documents that enabled services survive
  // while hand-run processes do not, and only the sysdiff can carry that.
  await exec(
    oriA,
    `printf '[Unit]\\nDescription=survival marker\\n[Service]\\nType=oneshot\\nRemainAfterExit=yes\\nExecStart=/bin/true\\n[Install]\\nWantedBy=multi-user.target\\n' | sudo tee /etc/systemd/system/survives.service >/dev/null && sudo systemctl enable survives.service`,
  );
  const enabledBefore = (await exec(oriA, "systemctl is-enabled survives.service")).stdout.trim();
  if (enabledBefore !== "enabled") fail(`unit not enabled before stop: ${enabledBefore}`);
  ok("wrote a file and enabled a systemd unit");

  // A hand-run process, which must NOT come back — the documented negative.
  await exec(oriA, "nohup sleep 3600 >/dev/null 2>&1 & echo started");
  const runningBefore = (await exec(oriA, "pgrep -c 'sleep 3600' || true")).stdout.trim();
  ok(`started a hand-run process (pgrep count ${runningBefore})`);

  // 2. stop: a real final snapshot into minio, then the container is destroyed -------
  const stopped = await api("POST", `/oris/${oriA}/stop`, {});
  if (stopped.status !== 202) {
    fail(`stop refused: HTTP ${stopped.status} ${JSON.stringify(stopped.json).slice(0, 400)}`);
  }
  await waitState(oriA, "archived");
  if ((await sh(["docker", "inspect", "-f", "{{.Id}}", machineA!])).code === 0) {
    fail("the container still exists after archive");
  }
  ok("stopped: final snapshot registered and the container destroyed");

  // Read the DB, not GET /oris/{id}/snapshots — that endpoint is T-P5-08 and does not
  // exist yet. This is about whether a snapshot was REGISTERED, which is what resume needs.
  const rows = await db
    .select()
    .from(schema.snapshots)
    .where((await import("drizzle-orm")).eq(schema.snapshots.oriId, oriA));
  if (rows.length === 0) fail("no snapshot row registered for this ori");
  ok(`snapshot registered (${rows.length} row(s), generation ${rows[0].generation})`);

  // 3. resume: a brand-new container, restored from object storage -------------------
  const resumed = await api("POST", `/oris/${oriA}/resume`, {});
  if (resumed.status !== 202) fail(`resume: HTTP ${resumed.status} ${JSON.stringify(resumed.json).slice(0, 300)}`);
  await waitState(oriA, "ready");
  const machineA2 = await machineOf(oriA);
  if (!machineA2 || machineA2 === machineA) fail("resume did not build a new machine");
  ok(`resumed onto a NEW machine ${machineA2.slice(0, 12)} (was ${machineA!.slice(0, 12)})`);

  // 4. the four survival claims -----------------------------------------------------
  const back = await exec(oriA, `cat ${MARKER}`);
  if (back.stdout !== CONTENT) fail(`file did not survive: ${JSON.stringify(back.stdout)}`);
  ok("FILE survived the stop/resume");

  const enabledAfter = (await exec(oriA, "systemctl is-enabled survives.service 2>&1 || true")).stdout.trim();
  if (!enabledAfter.startsWith("enabled")) fail(`enabled unit did not survive: ${enabledAfter}`);
  ok("ENABLED UNIT survived (the sysdiff did its job)");

  const runningAfter = (await exec(oriA, "pgrep -c 'sleep 3600' || true")).stdout.trim();
  if (runningAfter !== "0" && runningAfter !== "") {
    fail(`a hand-run process came back (count ${runningAfter}); the published spec documents that it must not`);
  }
  ok("HAND-RUN PROCESS did not come back, exactly as documented");

  // 5. fork, and prove independence -------------------------------------------------
  const forked = await api("POST", `/oris/${oriA}/fork`, {});
  if (forked.status !== 202) fail(`fork: HTTP ${forked.status} ${JSON.stringify(forked.json).slice(0, 300)}`);
  const oriB = forked.json.ori.id as string;
  await waitState(oriB, "ready");
  await machineOf(oriB);
  if (oriB === oriA) fail("fork returned the same ori id");
  ok(`forked into ${oriB}`);

  const forkSees = await exec(oriB, `cat ${MARKER}`);
  if (forkSees.stdout !== CONTENT) fail(`fork did not inherit the file: ${JSON.stringify(forkSees.stdout)}`);
  ok("the fork inherited the parent's file");

  await exec(oriB, `printf 'only in the fork\\n' >> ${MARKER}`);
  const parentStill = await exec(oriA, `cat ${MARKER}`);
  if (parentStill.stdout !== CONTENT) {
    fail(`writing in the fork changed the PARENT — they share state: ${JSON.stringify(parentStill.stdout)}`);
  }
  ok("writing in the fork left the parent untouched — they are independent");

  console.log("\ne2e-survival: PASS");
} catch (err) {
  console.error(`\ne2e-survival: FAIL — ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  for (const m of machines) await sh(["docker", "rm", "-f", m]);
  if (machines.length > 0) console.log(`  cleanup: removed ${machines.length} container(s)`);
  try {
    await db.$client?.end?.();
  } catch {
    /* best effort */
  }
  await psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  console.log(`  cleanup: dropped ${DB_NAME}`);
}
