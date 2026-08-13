import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod, chown, stat } from "node:fs/promises";
import { homeOwner, SSH_USER } from "./user";

/**
 * POST /sshkey — authorise an OpenSSH public key so the caller can `ssh user@<ori>`.
 *
 * This is how the CLI works: it keeps its own key, pushes the public half through this
 * endpoint, then execs the system ssh. So the endpoint's job is narrow: append one public key to
 * <workDir>/.ssh/authorized_keys with the permissions sshd insists on.
 *
 * sshd is unforgiving about modes: it silently refuses a key if ~/.ssh is group-writable or
 * authorized_keys is not owner-only. A "the key was added but login fails" bug is miserable
 * to diagnose from the outside, so the modes are set explicitly every time rather than
 * assumed from the umask.
 */

export class SshKeyError extends Error {
  constructor(
    readonly status: 400 | 500,
    message: string,
  ) {
    super(message);
    this.name = "SshKeyError";
  }
}

/**
 * Accept only a single-line OpenSSH public key of a modern type. Rejecting rather than
 * appending anything means a malformed value cannot corrupt authorized_keys — one bad line
 * makes sshd ignore the file's remaining entries, so a careless push could lock the owner
 * out of their own ori.
 */
const KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]{32,} ?[^\n\r]*$/;

export function validatePublicKey(key: unknown): string {
  if (typeof key !== "string") throw new SshKeyError(400, "key must be a string");
  const trimmed = key.trim();
  if (trimmed.length === 0) throw new SshKeyError(400, "key is empty");
  if (/[\n\r]/.test(trimmed)) throw new SshKeyError(400, "key must be a single line");
  if (trimmed.length > 16 * 1024) throw new SshKeyError(400, "key is implausibly long");
  if (!KEY_RE.test(trimmed)) throw new SshKeyError(400, "key is not a recognised OpenSSH public key");
  // A private key pasted here by mistake must never be written to authorized_keys.
  if (/PRIVATE KEY/i.test(trimmed)) throw new SshKeyError(400, "that looks like a PRIVATE key");
  return trimmed;
}

export interface AuthorizeKeyInput {
  workDir: string;
  key: string;
  /** Injected in tests; real oris run as root and own the user's home. */
  chownTo?: { uid: number; gid: number };
}

export interface AuthorizeKeyResult {
  ok: true;
  /** The SSH user a caller should connect as. */
  sshUser: string;
  /** Keys now present in authorized_keys. */
  keyCount: number;
  /** True when this exact key was already authorised. */
  alreadyPresent: boolean;
}

// SSH_USER and homeOwner live in user.ts: /exec and /file need the same answer, and three
// private copies of "who owns the home" is how the root-ownership bugs got in.
export { SSH_USER };

export async function authorizeKey(input: AuthorizeKeyInput): Promise<AuthorizeKeyResult> {
  const key = validatePublicKey(input.key);
  const sshDir = join(input.workDir, ".ssh");
  const authFile = join(sshDir, "authorized_keys");

  await mkdir(sshDir, { recursive: true });
  await chmod(sshDir, 0o700);

  let existing = "";
  if (await stat(authFile).then(() => true).catch(() => false)) {
    existing = await readFile(authFile, "utf8");
  }
  const lines = existing.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  // Compare on the key material, not the whole line: the trailing comment is free-form and
  // re-pushing the same key from a renamed laptop must not add a duplicate.
  const material = (l: string) => l.split(/\s+/).slice(0, 2).join(" ");
  const alreadyPresent = lines.some((l) => material(l) === material(key));
  if (!alreadyPresent) lines.push(key);

  await writeFile(authFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  await chmod(authFile, 0o600);

  // sshd refuses a key when the home directory itself is group- or world-writable.
  await chmod(input.workDir, 0o755).catch(() => {
    /* not fatal: a test temp dir may already be fine */
  });

  // OWNERSHIP, and this is the part that actually decides whether login works. The guest
  // agent runs as root, so everything it writes is root-owned — and sshd's StrictModes
  // refuses an authorized_keys the login user does not own, with nothing but
  // "Permission denied (publickey)" on the client side and no hint at all. Inherit the
  // owner of the home directory rather than assuming a uid: the ori's user is uid 1001
  // today, and hardcoding that would break the moment the image changes.
  const owner = input.chownTo ?? (await homeOwner(input.workDir));
  if (owner) {
    await chown(sshDir, owner.uid, owner.gid).catch(() => {});
    await chown(authFile, owner.uid, owner.gid).catch(() => {});
  }

  return { ok: true, sshUser: SSH_USER, keyCount: lines.length, alreadyPresent };
}
