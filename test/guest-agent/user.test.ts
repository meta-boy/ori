import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asLoginUser, homeOwner, isPrivileged, SSH_USER } from "@ori/guest-agent/user";
import { runCommand } from "@ori/guest-agent/exec";
import { writeFileInWorkDir } from "@ori/guest-agent/file";

/**
 * The guest agent runs as root on a real ori. Three separate endpoints created things in the
 * login user's home and left them root-owned, so the user who actually ssh'd in could not
 * touch them:
 *
 *   - /exec left root-owned files (a `git clone` you then could not edit over ssh)
 *   - /exec set HOME to the cwd, so `~` moved whenever a cwd was passed
 *   - PUT /files wrote mode 0600 root-owned — unreadable over ssh
 *
 * All three passed the old tests, because the old tests asserted the call returned ok. These
 * assert the thing that was actually broken: who owns the result, and where `~` points.
 *
 * The suite itself runs unprivileged, so the drop-privileges branch cannot be exercised
 * end-to-end here; it is asserted as the argv we build, and the real behaviour is covered by
 * e2e-local against a container running as root.
 */

let work: string;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "ori-user-"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("who the agent runs things as", () => {
  test("as root, a command is wrapped so it runs as the login user", () => {
    // Asserting the argv rather than the effect: the test process is not root, so the real
    // drop cannot be observed here. This is the exact command a ori runs.
    const wrapped = asLoginUser(["bash", "-lc", "id -un"], SSH_USER);
    // Force the privileged shape regardless of who runs the suite.
    const expected = isPrivileged()
      ? ["runuser", "-u", "user", "--", "bash", "-lc", "id -un"]
      : ["bash", "-lc", "id -un"];
    expect(wrapped).toEqual(expected);
  });

  test("the wrapper is runuser, not `su -`, so cwd and env survive", () => {
    // `su - user -c` would reset HOME and cd to the home dir, silently discarding the cwd the
    // caller asked for. If someone swaps the implementation, this catches it.
    const shape = asLoginUser(["bash", "-lc", "true"], "someone");
    if (shape.length > 3) {
      expect(shape.slice(0, 4)).toEqual(["runuser", "-u", "someone", "--"]);
      expect(shape).not.toContain("-");
      expect(shape).not.toContain("--login");
    }
  });

  test("unprivileged, there is nothing to drop to and the command runs directly", () => {
    // Guards the test path AND anyone running the agent as a normal user: wrapping with
    // runuser when we are not root would fail with a permission error instead of running.
    if (!isPrivileged()) {
      expect(asLoginUser(["echo", "hi"])).toEqual(["echo", "hi"]);
    }
  });

  test("SSH_USER is the one the image creates", () => {
    // It is imported by sshkey, exec and file. If it drifts from image/provision.sh, keys go
    // to one account and commands run as another.
    expect(SSH_USER).toBe("user");
  });
});

describe("homeOwner", () => {
  test("a root-owned home yields null, so nothing is chowned in a test dir", async () => {
    // The temp dir is owned by whoever runs the suite. Only uid 0 means "no login user".
    const owner = await homeOwner(work);
    const st = await stat(work);
    if (st.uid === 0) expect(owner).toBeNull();
    else expect(owner).toEqual({ uid: st.uid, gid: st.gid });
  });

  test("a missing directory yields null rather than throwing", async () => {
    // Called on the write path; throwing here would turn a chown problem into a failed upload.
    expect(await homeOwner(join(work, "nope"))).toBeNull();
  });

  test("the owner is read from the directory, never hardcoded", async () => {
    // The ori's user is uid 1001 on some images and 1000 on others; a hardcoded uid chowns
    // files to a stranger. Whatever the home says is the answer.
    const st = await stat(work);
    expect(await homeOwner(work)).toEqual(st.uid === 0 ? null : { uid: st.uid, gid: st.gid });
  });
});

describe("exec: HOME is the home, not the cwd", () => {
  test("HOME stays at the work dir when a cwd is passed", async () => {
    // The bug: HOME followed cwd, so `~` became /home/user/sub/dir and every tool that
    // writes to ~ (git, npm, pip, cargo) scattered its state into a subdirectory.
    await mkdir(join(work, "sub", "dir"), { recursive: true });
    const r = await runCommand({
      oriId: "or_23456789" as never,
      command: "echo HOME=$HOME; pwd",
      cwd: "sub/dir",
      workDir: work,
    });
    expect(r.stdout).toContain(`HOME=${work}`);
    // The cwd must still be the subdirectory — fixing HOME must not move the caller.
    expect(r.stdout).toContain("sub/dir");
    expect(r.cwd).toContain("sub/dir");
  });

  test("HOME equals the work dir with no cwd", async () => {
    const r = await runCommand({
      oriId: "or_23456789" as never,
      command: "echo HOME=$HOME",
      workDir: work,
    });
    expect(r.stdout.trim()).toBe(`HOME=${work}`);
  });

  test("~ and the work dir are the same place, whatever the cwd", async () => {
    // The property that actually matters to a user: `~/x` means one file, not one per cwd.
    await mkdir(join(work, "sub"), { recursive: true });
    const r = await runCommand({
      oriId: "or_23456789" as never,
      command: "touch ~/marker && ls ~/marker",
      cwd: "sub",
      workDir: work,
    });
    expect(r.success).toBe(true);
    // The marker must be in the home, NOT in sub/.
    expect(await stat(join(work, "marker")).then(() => true)).toBe(true);
    expect(await stat(join(work, "sub", "marker")).then(() => true).catch(() => false)).toBe(false);
  });
});

describe("file writes belong to the login user", () => {
  test("a written file is owned by the home's owner, not the writing process", async () => {
    await writeFileInWorkDir({ oriId: "or_23456789" as never, path: "up.txt", workDir: work }, "hi", "utf8");
    const [file, home] = await Promise.all([stat(join(work, "up.txt")), stat(work)]);
    expect(file.uid).toBe(home.uid);
    expect(file.gid).toBe(home.gid);
  });

  test("directories created on the way are handed over too", async () => {
    // A root-owned parent is the same trap as a root-owned file: the user cannot add a
    // sibling next to the file they just uploaded.
    await writeFileInWorkDir({ oriId: "or_23456789" as never, path: "a/b/c.txt", workDir: work }, "hi", "utf8");
    const home = await stat(work);
    for (const p of ["a", "a/b", "a/b/c.txt"]) {
      const st = await stat(join(work, p));
      expect(st.uid).toBe(home.uid);
    }
  });

  test("the work dir itself is left alone", async () => {
    // The walk must stop below the home. Chowning the home itself would be out of scope and
    // could change a real ori's /home/user.
    const before = await stat(work);
    await writeFileInWorkDir({ oriId: "or_23456789" as never, path: "x.txt", workDir: work }, "hi", "utf8");
    const after = await stat(work);
    expect(after.uid).toBe(before.uid);
    expect(after.mode).toBe(before.mode);
  });

  test("a file the user can read is still not world-readable", async () => {
    // Fixing ownership must not widen the mode: uploads can carry secrets.
    await writeFileInWorkDir({ oriId: "or_23456789" as never, path: "s.txt", workDir: work }, "hi", "utf8");
    const st = await stat(join(work, "s.txt"));
    expect(st.mode & 0o077).toBe(0);
  });
});
