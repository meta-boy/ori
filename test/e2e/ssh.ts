/**
 * T-P7 — can you actually SSH into a ori?
 *
 * `ori ssh` is the headline command: a ori you can read the disk of but cannot log into is
 * not a ori. This authorises a freshly generated key through POST /oris/{id}/sshkey and
 * then performs a REAL ssh login against the real container, because everything short of
 * that (the file landed, the mode is 0600) has been true before while login still failed —
 * sshd silently ignores an authorized_keys file whose permissions it dislikes.
 *
 * Run with `make e2e-ssh`.
 */
const PG_CONTAINER = process.env.PGC ?? "ori-postgres-1";
const DB_NAME = `ori_ssh_${process.pid}`;
const BASE = "/api/ori/v1";

let step = 0;
const ok = (m: string) => console.log(`  ✓ ${String(++step).padStart(2)} ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

async function sh(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}
const psql = (sql: string) =>
  sh(["docker", "exec", "-i", PG_CONTAINER, "psql", "-U", "ori", "-d", "ori", "-q", "-c", sql]);

if ((await sh(["docker", "version", "--format", "{{.Server.Version}}"])).code !== 0) {
  console.log("e2e-ssh: SKIPPED — docker unavailable");
  process.exit(0);
}
if ((await sh(["docker", "image", "inspect", "ori-base:latest", "-f", "{{.Id}}"])).code !== 0) {
  console.log("e2e-ssh: SKIPPED — ori-base:latest not built");
  process.exit(0);
}
if ((await sh(["docker", "inspect", "-f", "{{.State.Running}}", PG_CONTAINER])).out.trim() !== "true") {
  console.log("e2e-ssh: SKIPPED — postgres not running");
  process.exit(0);
}
if ((await sh(["sh", "-lc", "command -v ssh && command -v ssh-keygen"])).code !== 0) {
  console.log("e2e-ssh: SKIPPED — no ssh client");
  process.exit(0);
}

process.env.ORI_SNAPSHOT_SECRET ??= "e2e-ssh-secret";
process.env.S3_ENDPOINT_FOR_ORI ??= "http://host.docker.internal:9000";

console.log(`e2e-ssh: db ${DB_NAME}\n`);
await psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
await psql(`CREATE DATABASE ${DB_NAME}`);
process.env.DATABASE_URL = `postgres://ori:ori@localhost:5432/${DB_NAME}`;

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { postgresClient } = await import("@ori/api/db/client");
const schema = await import("@ori/api/db/schema");
const m = postgresClient(process.env.DATABASE_URL);
await migrate(drizzle(m, { schema }), {
  migrationsFolder: new URL("../../packages/api/drizzle", import.meta.url).pathname,
});
await m.end();

const { createApp } = await import("@ori/api/app");
const { makeDb } = await import("@ori/api/db/client");
const { TokenStore } = await import("@ori/api/tokens");
const { DockerMachineDriver } = await import("@ori/api/drivers/docker");
const { seedUserKey } = await import("../api/helpers");
const { mkdtemp, rm, readFile } = await import("node:fs/promises");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");

const db = makeDb();
const driver = new DockerMachineDriver();
const app = createApp({ db, driver, tokens: new TokenStore() });
const key = await seedUserKey(db);
const auth = { authorization: `Bearer ${key.secret}`, "content-type": "application/json" };
const machines: string[] = [];
let keyDir = "";

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
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

try {
  const created = await api("POST", "/oris", { ttlSeconds: 3600 });
  if (created.status !== 202) fail(`create: ${created.status} ${JSON.stringify(created.json)}`);
  const oriId = created.json.ori.id as string;
  for (let i = 0; i < 260; i++) {
    if ((await api("GET", `/oris/${oriId}`)).json.ori.state === "ready") break;
    await Bun.sleep(700);
  }
  const row = await db.query.oris.findFirst({ where: (b: any, { eq }: any) => eq(b.id, oriId) });
  if (row?.machineId) machines.push(row.machineId);
  ok(`ori ${oriId} ready`);

  // A real keypair, as the CLI would keep at ~/.ssh/<name>_ori_ed25519.
  keyDir = await mkdtemp(join(tmpdir(), "ori-ssh-key-"));
  const keyPath = join(keyDir, "id_ed25519");
  const kg = await sh(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "e2e@ori", "-f", keyPath]);
  if (kg.code !== 0) fail(`ssh-keygen failed: ${kg.err}`);
  const pub = (await readFile(`${keyPath}.pub`, "utf8")).trim();
  ok("generated an ed25519 keypair");

  // Authorise it.
  const authorized = await api("POST", `/oris/${oriId}/sshkey`, { key: pub });
  if (authorized.status !== 200) fail(`sshkey: ${authorized.status} ${JSON.stringify(authorized.json)}`);
  if (authorized.json.sshUser !== "user") fail(`unexpected sshUser ${authorized.json.sshUser}`);
  const { sshHost, sshPort } = authorized.json;
  if (!sshHost || !sshPort) fail(`no ssh address returned: ${JSON.stringify(authorized.json)}`);
  ok(`key authorized; connect at ${sshHost}:${sshPort} as ${authorized.json.sshUser}`);

  // Pushing the same key again must be idempotent — the CLI does it on every `ori ssh`.
  const again = await api("POST", `/oris/${oriId}/sshkey`, { key: pub });
  if (again.status !== 200 || again.json.alreadyPresent !== true) {
    fail(`second push was not idempotent: ${JSON.stringify(again.json)}`);
  }
  ok("re-pushing the same key is idempotent");

  // THE REAL TEST: log in and run something.
  const sshArgs = [
    "ssh",
    "-i",
    keyPath,
    "-p",
    String(sshPort),
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    `user@${sshHost}`,
    "id -un && uname -s && pwd",
  ];
  let login = await sh(sshArgs);
  // sshd may still be finishing its first-boot host-key generation; one retry.
  if (login.code !== 0) {
    await Bun.sleep(3000);
    login = await sh(sshArgs);
  }
  if (login.code !== 0) fail(`ssh login failed (${login.code}): ${login.err.trim().slice(0, 400)}`);
  const lines = login.out.trim().split("\n").map((l) => l.trim());
  if (lines[0] !== "user") fail(`logged in as ${lines[0]}, expected user`);
  if (lines[1] !== "Linux") fail(`uname says ${lines[1]}`);
  ok(`SSH LOGIN WORKS: whoami=${lines[0]} uname=${lines[1]} pwd=${lines[2]}`);

  // And a key that was never authorised must be refused.
  const otherDir = await mkdtemp(join(tmpdir(), "ori-ssh-other-"));
  const otherKey = join(otherDir, "id_ed25519");
  await sh(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "stranger", "-f", otherKey]);
  const denied = await sh([
    "ssh",
    "-i",
    otherKey,
    "-p",
    String(sshPort),
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    `user@${sshHost}`,
    "echo in",
  ]);
  if (denied.code === 0) fail("an UNAUTHORISED key was accepted");
  ok("an unauthorised key is refused");
  await rm(otherDir, { recursive: true, force: true });

  // Password auth must be off entirely, or the key is beside the point.
  const pw = await sh([
    "ssh",
    "-p",
    String(sshPort),
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "PreferredAuthentications=password",
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    `user@${sshHost}`,
    "echo in",
  ]);
  if (pw.code === 0) fail("password authentication succeeded; it must be disabled");
  ok("password authentication is refused");

  console.log("\ne2e-ssh: PASS");
} catch (err) {
  console.error(`\ne2e-ssh: FAIL — ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  for (const mid of machines) await sh(["docker", "rm", "-f", mid]);
  if (machines.length) console.log(`  cleanup: removed ${machines.length} container(s)`);
  if (keyDir) await rm(keyDir, { recursive: true, force: true }).catch(() => {});
  try {
    await db.$client?.end?.();
  } catch {
    /* best effort */
  }
  await psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  console.log(`  cleanup: dropped ${DB_NAME}`);
}
