/**
 * Local state and transport for the CLI: where the config lives, how output is emitted, and
 * the one authenticated fetch every command goes through. Separated from index.ts so the
 * command table there reads as commands rather than plumbing.
 */
import { mkdir, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ori");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const KEY_PATH = join(homedir(), ".ssh", "ori_ed25519");

interface Config {
  apiUrl: string;
  token?: string;
}

const DEFAULT_API = process.env.ORI_API_URL ?? "http://localhost:8787";

async function loadConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
    return { apiUrl: process.env.ORI_API_URL ?? raw.apiUrl ?? DEFAULT_API, token: raw.token };
  } catch {
    return { apiUrl: DEFAULT_API };
  }
}

async function saveConfig(cfg: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  // The token is a credential; a config file the whole machine can read is not acceptable.
  await chmod(CONFIG_PATH, 0o600);
}

/* ------------------------------- output ------------------------------- */

let jsonMode = false;

function out(human: string, data?: unknown): void {
  // --json emits one JSON object per line (JSONL), so `ori list --json | jq` works and a
  // script never has to parse the human table.
  if (jsonMode) console.log(JSON.stringify(data ?? { message: human }));
  else console.log(human);
}
function die(message: string, code = 1): never {
  if (jsonMode) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`ori: ${message}`);
  process.exit(code);
}

/* -------------------------------- version ------------------------------ */

/**
 * Stamped at compile time by scripts/build-cli.sh via `bun build --define`. Running from
 * source there is nothing to stamp, hence the fallback — a binary that cannot say what it is
 * makes every bug report start with a guess.
 */
declare const ORI_BUILD_VERSION: string | undefined;
declare const ORI_BUILD_COMMIT: string | undefined;

const VERSION = typeof ORI_BUILD_VERSION === "string" ? ORI_BUILD_VERSION : "dev";
const COMMIT = typeof ORI_BUILD_COMMIT === "string" ? ORI_BUILD_COMMIT : "source";

/* --------------------------------- debug ------------------------------- */

/** `--debug`, or ORI_DEBUG=1 for when the flag cannot be passed (ProxyCommand, scripts). */
let debugMode = false;

function debug(message: string, extra?: unknown): void {
  if (!debugMode) return;
  const suffix = extra === undefined ? "" : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  // stderr, always: stdout is the command's actual output and may be piped into jq.
  process.stderr.write(`\x1b[2mori debug:\x1b[0m ${message}${suffix}\n`);
}

/* --------------------------------- api -------------------------------- */

async function api(
  cfg: Config,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  if (!cfg.token) die("not logged in — run: ori login <api-key>");
  let res: Response;
  const started = Date.now();
  debug(`${method} ${cfg.apiUrl}/api/ori/v1${path}`, body === undefined ? undefined : body);
  try {
    res = await fetch(`${cfg.apiUrl}/api/ori/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    // A refused connection is the single most common failure here, and "fetch failed" tells
    // the user nothing about what to do.
    debug("request threw", (e as Error).message);
    die(`cannot reach the control plane at ${cfg.apiUrl} (${(e as Error).message})`);
  }
  debug(`  -> ${res.status} in ${Date.now() - started}ms`);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
}

/** Call the API and exit with the server's message when it refuses. */
async function apiOk(cfg: Config, method: string, path: string, body?: unknown): Promise<any> {
  const { status, json } = await api(cfg, method, path, body);
  if (status >= 400) {
    const msg = json?.message ?? json?.error ?? `HTTP ${status}`;
    die(`${msg}${json?.code ? ` (${json.code})` : ""}`, 1);
  }
  return json;
}

/**
 * Like api() but returns the RAW Response without consuming the body — for
 * endpoints that stream bytes (snapshot pull) where buffering into a string
 * would load the whole payload into memory and corrupt it.
 */
async function rawApi(cfg: Config, method: string, path: string): Promise<Response> {
  if (!cfg.token) die("not logged in — run: ori login <api-key>");
  try {
    return await fetch(`${cfg.apiUrl}/api/ori/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}` },
    });
  } catch (e) {
    die(`cannot reach the control plane at ${cfg.apiUrl} (${(e as Error).message})`);
  }
}

/** One event as a human line. */
function fmtEvent(e: any): string {
  const ts = new Date(e.timestamp).toISOString();
  const extra = e.data && Object.keys(e.data).length > 0 ? ` ${JSON.stringify(e.data)}` : "";
  return `${ts}  ${e.type}${extra}`;
}

/** Set once from main(), before any command runs. */
export function setModes(json: boolean, dbg: boolean): void {
  jsonMode = json;
  debugMode = dbg;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export { CONFIG_DIR, CONFIG_PATH, KEY_PATH, DEFAULT_API, loadConfig, saveConfig, out, die, debug, api, apiOk, rawApi, fmtEvent, VERSION, COMMIT };
export type { Config };
