/**
 * Password hashing.
 *
 * Bun.password is argon2id by default, which is what you want and means no dependency to audit
 * or keep current. The only interesting logic here is making failure uniform.
 */

/**
 * Long enough to matter, short enough not to be theatre. Bun's argon2 cost is what actually
 * defends a stolen hash; a length rule mainly stops "1234".
 */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 512; // argon2 is deliberately slow; do not let a request pick how slow

/**
 * An argon2 hash of a value nobody knows, computed once at startup.
 *
 * Used to verify against when the email does not exist. Without it, "no such user" returns
 * immediately while "wrong password" takes the full argon2 time, and the difference tells an
 * attacker which emails are registered. Verifying against a real hash makes both paths cost the
 * same.
 */
let decoyHash: string | null = null;

async function decoy(): Promise<string> {
  decoyHash ??= await Bun.password.hash(`decoy:${crypto.randomUUID()}`);
  return decoyHash;
}

export function validatePassword(password: unknown): { ok: true } | { ok: false; message: string } {
  if (typeof password !== "string") return { ok: false, message: "password is required" };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: `password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  return { ok: true };
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password); // argon2id, Bun's default
}

/**
 * Verify a password against a stored hash, taking the same time whether or not the account
 * exists. Pass `null` when there is no such user, or when the user is a service identity with no
 * password: both must be indistinguishable from a wrong password.
 */
export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (!hash) {
    await Bun.password.verify(password, await decoy()).catch(() => false);
    return false;
  }
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    // A malformed stored hash is a failed login, never a 500 that reveals the account exists.
    return false;
  }
}
