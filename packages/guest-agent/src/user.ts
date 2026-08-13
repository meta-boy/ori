import { stat, chown } from "node:fs/promises";

/**
 * Who a ori belongs to, in one place.
 *
 * The guest agent runs as **root** — it has to, for snapshot, restore, /etc/ori.env and
 * package installs. But every path a caller touches lives in the login user's home, and root
 * creating files there is a trap: the file lands root-owned, and the user who actually `ssh`s
 * in cannot read or modify it.
 *
 * That bug shipped three times before this file existed — `/exec` left root-owned files in
 * /home/user, `PUT /files` wrote mode 0600 root-owned (unreadable over ssh), and each of them
 * resolved "the user" its own way. Anything that creates or runs something on a caller's
 * behalf resolves the identity HERE, so the three cannot drift apart again.
 */

/** The account a caller logs in as. Must match the image's user (image/provision.sh). */
export const SSH_USER = "user";

export interface Owner {
  uid: number;
  gid: number;
}

/**
 * uid/gid of the home directory, so anything we create there ends up owned by whoever logs
 * in. Read from the directory rather than hardcoded: the ori's user is uid 1001 on some
 * images and 1000 on others, and guessing wrong is worse than not chowning at all.
 *
 * Returns null when the home is root-owned — that means a bare test directory, where there is
 * no login user to inherit from and chowning would be wrong.
 */
export async function homeOwner(workDir: string): Promise<Owner | null> {
  try {
    const st = await stat(workDir);
    if (st.uid === 0) return null;
    return { uid: st.uid, gid: st.gid };
  } catch {
    return null;
  }
}

/**
 * Give `path` to the home's owner. Best-effort by design: a chown failure must not fail the
 * operation that wrote the file, because the write itself succeeded and the caller can still
 * reach it through the API. Callers that need the chown to have worked should check.
 */
export async function giveToHomeOwner(workDir: string, path: string, owner?: Owner | null): Promise<void> {
  const target = owner ?? (await homeOwner(workDir));
  if (!target) return;
  await chown(path, target.uid, target.gid).catch(() => {});
}

/**
 * Are we root, and therefore obliged to drop privileges before running a caller's command?
 * Split out so tests can reason about both paths: on a real ori this is true, and in the test
 * suite (an unprivileged macOS process) it is false and there is nothing to drop to.
 */
export function isPrivileged(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Wrap a command so it runs as the login user instead of root.
 *
 * `runuser -u <user> --` keeps the environment and cwd we set (unlike `su -`, which would
 * reset both), so HOME and /etc/ori.env still apply. When the agent is not root there is
 * nothing to drop to and the command runs directly — that is the test path, and also what
 * happens if someone runs the agent unprivileged.
 *
 * Dropping privileges is safe rather than limiting: the login user has passwordless sudo, so
 * a command that genuinely needs root asks for it explicitly.
 */
export function asLoginUser(cmd: string[], user = SSH_USER): string[] {
  if (!isPrivileged()) return cmd;
  return ["runuser", "-u", user, "--", ...cmd];
}
