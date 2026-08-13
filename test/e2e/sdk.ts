/**
 * T-P11 — does a client GENERATED from the spec work against this server?
 *
 * This is the project's central claim, and until now it was only asserted. The contract
 * harness proves responses validate against the spec; it does not prove the spec is complete
 * enough to generate a client FROM. Those are different failures: a spec can describe every
 * response correctly and still omit a path, mistype a parameter, or get a request body wrong,
 * and only generation surfaces that.
 *
 * Every path, parameter, body and field below is typed from openapi/ori-v1.yaml via
 * openapi-typescript. A missing path or renamed field is a COMPILE error here, not a runtime
 * 404 discovered by a user.
 *
 * Run with `make e2e-sdk`.
 */
const PG = process.env.PGC ?? "ori-postgres-1";
const DB = `ori_sdk_${process.pid}`;

let step = 0;
const ok = (m: string) => console.log(`  ✓ ${String(++step).padStart(2)} ${m}`);
// Annotated on the VARIABLE, not just the arrow: without this TypeScript does not treat a
// call to it as terminating, so nothing after an `if (x.error) fail(...)` narrows and the
// result type collapses to never.
const fail: (m: string) => never = (m) => {
  throw new Error(m);
};

async function sh(cmd: string[]) {
  const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}
const psql = (sql: string) => sh(["docker", "exec", "-i", PG, "psql", "-U", "ori", "-d", "ori", "-q", "-c", sql]);

if ((await sh(["docker", "version"])).code !== 0) {
  console.log("e2e-sdk: SKIPPED — docker unavailable");
  process.exit(0);
}
if ((await sh(["docker", "image", "inspect", "ori-base:latest"])).code !== 0) {
  console.log("e2e-sdk: SKIPPED — ori-base:latest not built");
  process.exit(0);
}
if ((await sh(["docker", "inspect", "-f", "{{.State.Running}}", PG])).out.trim() !== "true") {
  console.log("e2e-sdk: SKIPPED — postgres not running");
  process.exit(0);
}

process.env.ORI_SNAPSHOT_SECRET ??= "e2e-sdk-secret";
process.env.S3_ENDPOINT_FOR_ORI ??= "http://host.docker.internal:9000";
// Deliberately NOT process.env.PORT. This suite starts its own server, and PORT means "the
// port the real control plane listens on" — inheriting it made the suite try to bind 8787 and
// die with "Is port 8787 in use?" whenever a dev server was running, which is exactly when
// someone is most likely to run the tests. A test's own address is not a deployment setting.
const port = 8802;

console.log(`e2e-sdk: db ${DB}, server :${port}\n`);
await psql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await psql(`CREATE DATABASE ${DB}`);
process.env.DATABASE_URL = `postgres://ori:ori@localhost:5432/${DB}`;

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { postgresClient, makeDb } = await import("@ori/api/db/client");
const schema = await import("@ori/api/db/schema");
const mig = postgresClient(process.env.DATABASE_URL);
await migrate(drizzle(mig, { schema }), {
  migrationsFolder: new URL("../../packages/api/drizzle", import.meta.url).pathname,
});
await mig.end();

const { createApp } = await import("@ori/api/app");
const { TokenStore } = await import("@ori/api/tokens");
const { DockerMachineDriver } = await import("@ori/api/drivers/docker");
const { seedUserKey } = await import("../api/helpers");
const { createOriClient } = await import("@ori/sdk-ts");

const db = makeDb();
const app = createApp({ db, driver: new DockerMachineDriver(), tokens: new TokenStore() });
const key = await seedUserKey(db);

// A REAL http server, not app.request(): a generated client speaks HTTP, and serving it
// in-process would skip the very layer being tested.
const server = Bun.serve({ port, fetch: app.fetch });
const machines: string[] = [];

/**
 * openapi-fetch resolves the RESULT type of a few operations in this spec to `never`, so
 * `.error`/`.data` cannot be read even though the call works perfectly at runtime (every
 * assertion below passes against a real server). The bodies and params ARE fully typed — the
 * three errors were all on reading the result — so what is lost here is the result's type, not
 * the request's.
 *
 * Narrowed to a named helper rather than sprinkling `as any`, so the compromise is visible in
 * one place and greppable. See packages/sdk-ts/README.md.
 */
type Result = { data?: any; error?: any };
const res = (r: unknown): Result => r as Result;


try {
  const client = createOriClient({ baseUrl: `http://localhost:${port}`, apiKey: key.secret });

  const me = await client.GET("/me");
  if (me.error) fail(`GET /me: ${JSON.stringify(me.error)}`);
  ok(`GET /me -> ${me.data!.user?.login}`);

  // `type` and `noEnv` are OPTIONAL in the spec (no `required` list, both have defaults), but
  // openapi-typescript marks a defaulted property as non-optional. That is right for a
  // response — the server has filled it in — and wrong for a request body, so a generated
  // caller is forced to pass them. Passing them rather than fighting the generator: the
  // alternative flag (--default-non-nullable false) makes openapi-fetch resolve several
  // operations to `never`. Recorded in packages/sdk-ts/README.md; it is a generator quirk,
  // not a gap in the spec.
  const created = await client.POST("/oris", {
    body: { ttlSeconds: 3600, type: "default", noEnv: false },
  });
  if (created.error) fail(`POST /oris: ${JSON.stringify(created.error)}`);
  const id = created.data!.ori.id!;
  ok(`POST /oris -> ${id} (${created.data!.ori.state})`);

  let state = created.data!.ori.state;
  for (let i = 0; i < 260 && state !== "ready"; i++) {
    await Bun.sleep(700);
    const got = await client.GET("/oris/{oriId}", { params: { path: { oriId: id } } });
    if (got.error) fail("GET /oris/{oriId} failed");
    state = got.data!.ori.state;
  }
  if (state !== "ready") fail(`ori stuck in ${state}`);
  const row = await db.query.oris.findFirst({ where: (b: any, { eq }: any) => eq(b.id, id) });
  if (row?.machineId) machines.push(row.machineId);
  ok(`GET /oris/{oriId} -> ready`);

  const cmd = await client.POST("/oris/{oriId}/commands", {
    params: { path: { oriId: id } },
    // timeoutSeconds is optional in the spec (default 30); the generator demands it. Same
    // quirk as `type`/`noEnv` above — see packages/sdk-ts/README.md.
    body: { command: "uname -s && echo from-the-generated-sdk", timeoutSeconds: 30 },
  });
  const cmdR = res(cmd);
  if (cmdR.error) fail(`commands: ${JSON.stringify(cmdR.error)}`);
  if (!cmdR.data.stdout?.includes("from-the-generated-sdk")) fail(`unexpected stdout ${cmdR.data.stdout}`);
  ok(`POST …/commands -> ${JSON.stringify(cmdR.data.stdout?.trim())}`);

  const put = await client.PUT("/oris/{oriId}/files", {
    params: { path: { oriId: id } },
    body: { path: "sdk/hello.txt", content: "written through the generated client\n", encoding: "utf8" },
  });
  if (res(put).error) fail(`PUT files: ${JSON.stringify(res(put).error)}`);
  const got = await client.GET("/oris/{oriId}/files", {
    params: { path: { oriId: id }, query: { path: "sdk/hello.txt" } },
  });
  const gotR = res(got);
  if (gotR.error) fail(`GET files: ${JSON.stringify(gotR.error)}`);
  if (gotR.data.content !== "written through the generated client\n") fail("file round-trip differs");
  ok("PUT + GET …/files round-trip byte-exact");

  const list = await client.GET("/oris");
  if (list.error) fail("GET /oris failed");
  ok(`GET /oris -> ${list.data!.oris.length} ori(es), hasMore=${list.data!.pageInfo?.hasMore}`);

  const events = await client.GET("/oris/{oriId}/events", { params: { path: { oriId: id } } });
  if (events.error) fail("GET events failed");
  ok(`GET …/events -> ${events.data!.events.length} event(s)`);

  const stopped = await client.POST("/oris/{oriId}/stop", {
    params: { path: { oriId: id } },
    body: { force: true },
  });
  if (stopped.error) fail(`stop: ${JSON.stringify(stopped.error)}`);
  ok(`POST …/stop -> ${stopped.data!.status}`);

  // An error must arrive in the documented envelope, not as a bare string: a generated client
  // branches on `code`, so a 404 that does not carry one is unusable to it.
  const missing = await client.GET("/oris/{oriId}", { params: { path: { oriId: "or_23456789" } } });
  if (!missing.error) fail("a nonexistent ori returned success");
  if ((missing.error as { code?: string }).code !== "not_found") {
    fail(`404 did not carry code=not_found: ${JSON.stringify(missing.error)}`);
  }
  ok("a 404 arrives in the documented error envelope");

  console.log("\ne2e-sdk: PASS — a client generated from the spec works unmodified");
} catch (err) {
  console.error(`\ne2e-sdk: FAIL — ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  server.stop();
  for (const m of machines) await sh(["docker", "rm", "-f", m]);
  if (machines.length) console.log(`  cleanup: removed ${machines.length} container(s)`);
  try {
    await db.$client?.end?.();
  } catch {
    /* best effort */
  }
  await psql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  console.log(`  cleanup: dropped ${DB}`);
}
