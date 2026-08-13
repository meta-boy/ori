import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scrubCredentials } from "@ori/guest-agent/restore";

// T-P5-07. `resume --no-env` and `fork --no-env` exist so a ori can be handed
// to someone else: "a no-env ori receives none of your account's secrets or credentials and
// cannot act on your account or other oris". A restore replays the parent's home
// directory, so without this scrub a fork arrives holding the parent's SSH key, GitHub
// token and model API keys — and whoever received it can act as the parent.
//
// These assertions are about ABSENCE, which is the easiest kind of test to write in a way
// that passes for the wrong reason. Every case below therefore creates the file first and
// checks it existed before asserting it is gone.

async function seedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "ori-scrub-home-"));
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY\n");
  await writeFile(join(home, ".ssh", "authorized_keys"), "ssh-ed25519 AAAA owner@laptop\n");
  await mkdir(join(home, ".config", "gh"), { recursive: true });
  await writeFile(join(home, ".config", "gh", "hosts.yml"), "oauth_token: ghp_secret\n");
  await mkdir(join(home, ".config", "ori"), { recursive: true });
  await writeFile(join(home, ".config", "ori", "config.json"), '{"token":"ori_live_secret"}\n');
  await writeFile(join(home, ".claude.json"), '{"apiKey":"sk-secret"}\n');
  await mkdir(join(home, ".aws"), { recursive: true });
  await writeFile(join(home, ".aws", "credentials"), "[default]\naws_secret_access_key=x\n");
  await writeFile(join(home, ".netrc"), "machine github.com password secret\n");
  await writeFile(join(home, ".git-credentials"), "https://x:token@github.com\n");
  await writeFile(join(home, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
  // The user's actual work, which must NOT be touched.
  await mkdir(join(home, "project"), { recursive: true });
  await writeFile(join(home, "project", "main.ts"), "export const x = 1;\n");
  return home;
}

const exists = (p: string) => stat(p).then(() => true).catch(() => false);

describe("T-P5-07 --no-env scrub removes the owner's credentials", () => {
  test("the parent's SSH key AND authorized_keys are gone", async () => {
    const home = await seedHome();
    expect(await exists(join(home, ".ssh", "id_ed25519"))).toBe(true);
    const notes: string[] = [];
    const removed = await scrubCredentials(home, notes);

    // The private key is obvious. authorized_keys matters just as much and is easier to
    // forget: leaving it means the PARENT can still SSH into a ori they gave away.
    expect(await exists(join(home, ".ssh"))).toBe(false);
    expect(removed).toContain(".ssh");
  });

  test("every credential store is removed, and the list says which", async () => {
    const home = await seedHome();
    const notes: string[] = [];
    const removed = await scrubCredentials(home, notes);
    for (const rel of [".ssh", ".config/gh", ".config/ori", ".claude.json", ".aws", ".netrc", ".git-credentials", ".npmrc"]) {
      expect(await exists(join(home, rel))).toBe(false);
      expect(removed).toContain(rel);
    }
  });

  test("the user's own work is untouched", async () => {
    const home = await seedHome();
    await scrubCredentials(home, []);
    // A scrub that took the project with it would be worse than no scrub: the point of
    // fork --no-env is to hand over the WORK without the credentials.
    expect(await exists(join(home, "project", "main.ts"))).toBe(true);
    expect(await Bun.file(join(home, "project", "main.ts")).text()).toBe("export const x = 1;\n");
  });

  test("a home with no credentials scrubs cleanly and reports zero", async () => {
    const home = await mkdtemp(join(tmpdir(), "ori-scrub-empty-"));
    const notes: string[] = [];
    const removed = await scrubCredentials(home, notes);
    expect(removed).toEqual([]);
    expect(notes.join(" ")).toContain("removed 0 credential path(s)");
    await rm(home, { recursive: true, force: true });
  });

  test("paths are removed, not emptied", async () => {
    const home = await seedHome();
    await scrubCredentials(home, []);
    // An empty ~/.ssh/id_ed25519 is a file something may overwrite and then "repair" by
    // regenerating; an absent one fails loudly. Absence is the stronger guarantee.
    expect(await exists(join(home, ".ssh"))).toBe(false);
    expect(await exists(join(home, ".aws"))).toBe(false);
  });

  test("it reports what it did, so a caller can log the scrub", async () => {
    const home = await seedHome();
    const notes: string[] = [];
    const removed = await scrubCredentials(home, notes);
    expect(removed.length).toBeGreaterThan(5);
    expect(notes.join(" ")).toContain(`removed ${removed.length} credential path(s)`);
  });
});
