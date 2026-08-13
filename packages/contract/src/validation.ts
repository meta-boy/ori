export const ENV_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]{0,127}$";
export const envNameRegex = new RegExp(ENV_NAME_PATTERN);

export const MAX_ENV_VARS = 100;
export const MAX_ENV_BYTES = 64 * 1024;

/** Reserved names rejected with invalid_env (see CreateOriRequest.env doc). */
export const RESERVED_ENV_NAMES = new Set([
  // Exactly the names the control plane injects into a ori (see the drivers' agentEnv) plus
  // the CLI's own token. A ori that could set these could impersonate the control plane to
  // its own guest agent, or point the agent at a different control plane.
  "ORI_ID",
  "ORI_AGENT_TOKEN",
  "ORI_MACHINE_TOKEN",
  "ORI_CONTROL_PLANE",
  "ORI_CLI_TOKEN",
]);

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function isValidEnvName(name: string): boolean {
  return envNameRegex.test(name);
}

export function envBytes(entries: Iterable<[string, string]>): number {
  let total = 0;
  for (const [k, v] of entries) total += k.length + v.length;
  return total;
}

/** Validate a per-ori env map against name regex, count, size and reserved-name rules. */
export function validateEnvObject(
  env: Record<string, string> | undefined,
): ValidationResult {
  if (env === undefined) return { ok: true };
  const entries = Object.entries(env);
  if (entries.length > MAX_ENV_VARS) {
    return { ok: false, code: "invalid_env", message: `at most ${MAX_ENV_VARS} env variables allowed` };
  }
  if (envBytes(entries) > MAX_ENV_BYTES) {
    return { ok: false, code: "invalid_env", message: "env exceeds 64KB" };
  }
  for (const key of Object.keys(env)) {
    if (!isValidEnvName(key)) {
      return { ok: false, code: "invalid_env", message: `invalid env name: ${key}` };
    }
    if (RESERVED_ENV_NAMES.has(key)) {
      return { ok: false, code: "invalid_env", message: `reserved env name: ${key}` };
    }
  }
  return { ok: true };
}

/** Parse dotenv-style content into entries. Lines `KEY=VALUE`; blank/# lines ignored. */
export function parseEnvContents(contents: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (contents === undefined) return map;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

/** Validate a `.env`-style string. */
export function validateEnvContents(contents: string | undefined): ValidationResult {
  if (contents === undefined) return { ok: true };
  if (contents.length > MAX_ENV_BYTES) {
    return { ok: false, code: "invalid_env", message: "env contents exceed 64KB" };
  }
  const map = parseEnvContents(contents);
  if (map.size > MAX_ENV_VARS) {
    return { ok: false, code: "invalid_env", message: `at most ${MAX_ENV_VARS} env variables allowed` };
  }
  for (const key of map.keys()) {
    if (!isValidEnvName(key)) {
      return { ok: false, code: "invalid_env", message: `invalid env name: ${key}` };
    }
    if (RESERVED_ENV_NAMES.has(key)) {
      return { ok: false, code: "invalid_env", message: `reserved env name: ${key}` };
    }
  }
  return { ok: true };
}

/**
 * Validate a secret-file path: relative to /home/user, no leading `/`, no `.`/`..` escapes,
 * no absolute paths. Returns ok or an invalid path result.
 */
export function validateSecretPath(path: string): ValidationResult {
  if (path.length === 0) {
    return { ok: false, code: "invalid_json", message: "empty secret file path" };
  }
  if (path.startsWith("/")) {
    return { ok: false, code: "invalid_json", message: `absolute secret file paths are skipped: ${path}` };
  }
  const segs = path.split("/");
  for (const seg of segs) {
    if (seg === "" || seg === "." || seg === "..") {
      return { ok: false, code: "invalid_json", message: `secret file path escapes work dir: ${path}` };
    }
  }
  return { ok: true };
}

export interface SecretFileInput {
  path: string;
  contents: string;
}

export function validateSecretFiles(files: SecretFileInput[] | undefined): ValidationResult {
  if (files === undefined) return { ok: true };
  for (const f of files) {
    const r = validateSecretPath(f.path);
    if (!r.ok) return r;
  }
  return { ok: true };
}

const SUBDOMAIN_PATTERN = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$";
export const subdomainRegex = new RegExp(SUBDOMAIN_PATTERN);

/** Reserved suffixes from the spec: cannot end in `-desktop` or `-<number>`. */
export function validateSubdomain(subdomain: string): ValidationResult {
  if (subdomain.length < 3 || subdomain.length > 40) {
    return { ok: false, code: "invalid_subdomain", message: "subdomain must be 3..40 chars" };
  }
  if (!subdomainRegex.test(subdomain)) {
    return { ok: false, code: "invalid_subdomain", message: `invalid subdomain: ${subdomain}` };
  }
  if (subdomain.endsWith("-desktop")) {
    return { ok: false, code: "invalid_subdomain", message: "subdomain cannot end in -desktop" };
  }
  if (/-\d+$/.test(subdomain)) {
    return { ok: false, code: "invalid_subdomain", message: "subdomain cannot end in a number" };
  }
  return { ok: true };
}

export function validateOriName(name: string): ValidationResult {
  if (name.length < 1) {
    return { ok: false, code: "invalid_name", message: "name cannot be empty" };
  }
  if (name.length > 120) {
    return { ok: false, code: "invalid_name", message: "name longer than 120 chars is truncated, not rejected" };
  }
  return { ok: true };
}

/** Validate a work-relative path used by /commands cwd or /files: no absolute, no escapes. */
export function validateWorkPath(path: string | undefined): ValidationResult {
  if (path === undefined || path === "") return { ok: true };
  if (path.startsWith("/")) {
    return { ok: false, code: "invalid_json", message: `absolute paths are rejected: ${path}` };
  }
  for (const seg of path.split("/")) {
    if (seg === ".." || seg === ".") {
      return { ok: false, code: "invalid_json", message: `path escapes work dir: ${path}` };
    }
  }
  return { ok: true };
}