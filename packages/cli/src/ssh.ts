/**
 * The ssh transport: the local keypair, the target `ori ssh`/`scp`/`forward` hand to the
 * system ssh, the ProxyCommand tunnel, and how a bare command resolves "which ori".
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR, KEY_PATH, apiOk, die, isJsonMode, type Config } from "./client";

/**
 * How long wake-on-connect will wait for a resumed ori to reach `ready`. A resume
 * restores the latest snapshot over the wire, which is minutes on a multi-GB ori — the
 * same budget `ori new` gives provisioning, because it is the same kind of wait.
 */
const WAKE_TIMEOUT_MS = 180_000;

/** Ensure a local keypair exists, returning the public half. */
async function ensureKey(): Promise<{ privatePath: string; publicKey: string }> {
  const pub = `${KEY_PATH}.pub`;
  if (!(await stat(pub).then(() => true).catch(() => false))) {
    await mkdir(join(homedir(), ".ssh"), { recursive: true });
    const p = Bun.spawn({
      cmd: ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", `ori@${process.env.USER ?? "cli"}`, "-f", KEY_PATH],
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await p.exited) !== 0) die(`ssh-keygen failed: ${await new Response(p.stderr).text()}`);
  }
  return { privatePath: KEY_PATH, publicKey: (await readFile(pub, "utf8")).trim() };
}

/**
 * Wake-on-connect: if the ori is archived, resume it and wait for it to be ready first.
 * `ori ssh`/`scp`/`exec` against a stopped ori would otherwise die with the API's
 * machine_not_running; auto-resuming makes the connect a no-op for the user instead of
 * demanding they run `ori resume` by hand. Prints a one-line notice, then waits the same
 * way `ori new` waits for provisioning.
 */
async function wakeIfArchived(cfg: Config, oriId: string): Promise<void> {
  const r = await apiOk(cfg, "GET", `/oris/${oriId}`);
  if (r.ori.state !== "archived") return;
  if (!isJsonMode()) process.stderr.write(`resuming ${oriId}...\n`);
  await apiOk(cfg, "POST", `/oris/${oriId}/resume`, {});
  const deadline = Date.now() + WAKE_TIMEOUT_MS;
  let state = r.ori.state;
  while (Date.now() < deadline && state !== "ready" && state !== "error") {
    await Bun.sleep(3000);
    if (!isJsonMode()) process.stderr.write(".");
    state = (await apiOk(cfg, "GET", `/oris/${oriId}`)).ori.state;
  }
  if (!isJsonMode()) process.stderr.write("\n");
  if (state !== "ready") die(`ori ${oriId} did not become ready (state ${state})`);
}

/**
 * Authorise our key on the ori and return the ssh target. Pushing on every connect is
 * deliberate and cheap: the ori may have been resumed onto a new machine since last time, in
 * which case the old authorisation is gone with the old container.
 */
async function sshTarget(cfg: Config, oriId: string): Promise<{ args: string[]; privatePath: string }> {
  await wakeIfArchived(cfg, oriId);

  const { privatePath, publicKey } = await ensureKey();
  const r = await apiOk(cfg, "POST", `/oris/${oriId}/sshkey`, { key: publicKey });
  const user = r.sshUser ?? "user";

  /*
   * Host keys are pinned per MACHINE, not per ori.
   *
   * A resume or a fork builds a new machine, and a machine generates its own host keys — so the
   * same ori id honestly presents a different key afterwards. Pinned by id, ssh answered every
   * resume with the full "REMOTE HOST IDENTIFICATION HAS CHANGED / someone could be
   * eavesdropping" banner and refused to connect, for something entirely expected. Teaching a
   * user to clear that warning routinely is worse than not showing it: the next one is real.
   *
   * HostKeyAlias decouples the known_hosts name from the address dialled (which is a loopback
   * port or a ProxyCommand anyway), so a rebuilt machine is simply a new entry that
   * accept-new takes silently, while a changed key for the same machine still stops the
   * connection.
   */
  const alias = r.machineId ? `${oriId}.${String(r.machineId).slice(0, 12)}` : oriId;

  const common = [
    "-i",
    privatePath,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `HostKeyAlias=${alias}`,
    "-o",
    `UserKnownHostsFile=${join(CONFIG_DIR, "known_hosts")}`,
  ];

  /*
   * The address the server reports is the ori's sshd as seen FROM THE CONTROL-PLANE HOST —
   * under the docker driver that is `127.0.0.1:<published port>`. Dialling it works only when
   * the CLI runs on that same host, and fails with "connection refused" everywhere else,
   * against a ori that is perfectly healthy.
   *
   * So unless the control plane is local, tunnel through the API instead: ssh runs over a
   * WebSocket to an endpoint this CLI is already authenticated to. Same bytes, same ssh
   * cryptography end to end; only the transport changes.
   */
  const apiIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(cfg.apiUrl);
  const host = r.sshHost ?? r.machineIp;

  if (apiIsLocal && host) {
    return {
      privatePath,
      args: [...common, "-p", String(r.sshPort ?? 22), `${user}@${host}`],
    };
  }

  // ProxyCommand runs this same binary in tunnel mode and speaks ssh down its stdio.
  const self = process.execPath.endsWith("bun")
    ? `${process.execPath} ${import.meta.path}` // running from source
    : process.execPath; // the compiled single-file binary
  return {
    privatePath,
    args: [
      ...common,
      "-o",
      // --api-url is passed explicitly: the child is a fresh process, and without it the
      // tunnel resolves the URL from stored config and quietly dials a different control
      // plane than the one this command was aimed at.
      `ProxyCommand=${self} ssh-tunnel ${oriId} --api-url ${cfg.apiUrl}`,
      // The hostname is never resolved (ProxyCommand supplies the socket) but ssh still uses
      // it as the known_hosts key, so it must be stable per ori rather than per address.
      `${user}@${oriId}`,
    ],
  };
}

/**
 * Pipe stdin/stdout to a ori's sshd through the control plane. Invoked by ssh as its
 * ProxyCommand, never by a human — hence no help entry.
 */
async function sshTunnel(cfg: Config, oriId: string): Promise<never> {
  const wsUrl = `${cfg.apiUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/api/ori/v1/oris/${oriId}/ssh-tunnel`;
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${cfg.token}` } } as never);
  ws.binaryType = "arraybuffer";

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    // A refused upgrade arrives as an error with no detail, so say what the likely causes are
    // rather than printing "error" and leaving ssh to report a broken pipe.
    ws.onerror = () => reject(new Error(`could not open the ssh tunnel to ${oriId} — is the ori running, and is your key valid?`));
  }).catch((e: Error) => die(e.message));

  ws.onmessage = (ev) => {
    const data = ev.data;
    process.stdout.write(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
  };
  ws.onclose = () => process.exit(0);

  // getReader() rather than for-await: the stream is typed without an async iterator, and a
  // reader is what actually exists at runtime.
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done || ws.readyState !== WebSocket.OPEN) break;
    if (value) ws.send(value);
  }
  ws.close();
  process.exit(0);
}

/**
 * Ori's CLI reports the ori it just created back to the shell through a temp file named in
 * ORI_CURRENT_ID_FILE, and a shell function exports it as ORI_CURRENT_ID. That
 * is how `ori ssh` works with no argument right after `ori new`, without the CLI keeping
 * mutable state of its own — the shell owns "current", so two terminals never fight over it.
 */
async function reportCurrent(id: string): Promise<void> {
  const target = process.env.ORI_CURRENT_ID_FILE;
  if (!target) return;
  try {
    await writeFile(target, id);
  } catch {
    // Purely a convenience channel; never fail a command over it.
  }
}

/** The ori to act on when no id is given. */
function currentId(): string | undefined {
  return process.env.ORI_CURRENT_ID || undefined;
}

const ORI_ID_RE = /^or_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

/**
 * Resolve a ori argument, accepting the literal word `current`.
 *
 * Taken from this image CLI, which tells you: "you can refer to it also as \"current\"
 * instead of ID as long as you stay in this shell and it remains the last created ori in
 * there". Typing `current` is better than an env var nobody can see, and it costs one line.
 */
function resolveId(arg: string | undefined): string | undefined {
  if (arg === "current") return currentId();
  return arg ?? currentId();
}

/**
 * Split "[id] rest..." for commands that take trailing arguments (exec, ssh). Omitting the id
 * is ambiguous there — `ori exec 'echo hi'` could mean either — so the first token is treated
 * as an id only if it LOOKS like one. Ori ids have a fixed shape, which makes this reliable
 * rather than a guess, and a command that happens to be shaped like a ori id is not a thing.
 */
function splitIdAndRest(positional: string[]): { id?: string; rest: string[] } {
  const first = positional[1];
  if (first === "current") return { id: currentId(), rest: positional.slice(2) };
  if (first && ORI_ID_RE.test(first)) return { id: first, rest: positional.slice(2) };
  const cur = currentId();
  if (cur) return { id: cur, rest: positional.slice(1) };
  return { id: undefined, rest: positional.slice(1) };
}
/**
 * The argv scp gets, minus the binary: sshTarget's option flags with the trailing
 * `user@host` destination STRIPPED (scp must only see it inside a translated `host:path`
 * pair — as a bare argument scp stats it as a local file), `-p` respelled `-P` (scp's
 * uppercase port flag), then the src/dst pair.
 */
function scpArgv(targetArgs: string[], translated: string[]): string[] {
  const args = targetArgs.slice(0, -1);
  const pIdx = args.indexOf("-p");
  if (pIdx >= 0) args[pIdx] = "-P";
  return [...args, ...translated];
}

export { ensureKey, sshTarget, sshTunnel, wakeIfArchived, reportCurrent, currentId, resolveId, splitIdAndRest, scpArgv, ORI_ID_RE };
