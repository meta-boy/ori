import { describe, expect, test } from "bun:test";
import { DATABASE_URL } from "@ori/api/db/client";

/**
 * The credential scripts must TERMINATE, not merely print.
 *
 * create-invite.ts used to close a connection it never opened (postgresClient() returns a
 * fresh client, not makeDb()'s pool), so it printed the invite and then hung forever. That
 * was invisible while a human ran it and read the output — and blocking the moment
 * infra/lxc/ori.sh started calling it at the end of an unattended install.
 *
 * These run the real scripts against the real database, because the bug was entirely in
 * the process lifetime: every assertion about their output passed while they hung.
 */
const TIMEOUT_MS = 30_000;

async function runScript(script: string, args: string[]): Promise<{ code: number | null; out: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", script, ...args],
    env: { ...process.env, DATABASE_URL },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out };
}

describe("credential scripts exit on their own", () => {
  test("create-invite.ts prints an invite and exits 0", async () => {
    const { code, out } = await runScript("scripts/create-invite.ts", ["--note", "exit-test"]);
    expect(out).toContain("inv_");
    // A killed process reports its signal, so this fails loudly on a hang rather
    // than waiting out the test runner's own timeout.
    expect(code).toBe(0);
  }, 60_000);

  test("create-key.ts prints a key and exits 0", async () => {
    const { code, out } = await runScript("scripts/create-key.ts", ["--name", "exit-test"]);
    expect(out).toContain("ori_live_");
    expect(code).toBe(0);
  }, 60_000);
});
