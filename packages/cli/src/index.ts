#!/usr/bin/env bun
/**
 * `ori` — the CLI: the command table.
 *
 * A thin client over the HTTP API plus the system ssh: a single binary that keeps a key and a
 * token locally and execs ssh for interactive work. Anything clever belongs in the API, where
 * it is testable, not here.
 *
 * Two things are NOT here so this file stays a readable list of commands: `client.ts` (config,
 * output, the authenticated fetch) and `ssh.ts` (keypair, ssh target, tunnel, id resolution).
 *
 * Shipped as source and run with bun during development; `bun build --compile` turns this
 * into the single per-platform binary the install script serves.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONFIG_PATH,
  DEFAULT_API,
  debug,
  api,
  apiOk,
  die,
  fmtEvent,
  isJsonMode,
  loadConfig,
  out,
  rawApi,
  saveConfig,
  setModes,
  VERSION,
  COMMIT,
  type Config,
} from "./client";
import { ORI_ID_RE, ensureKey, reportCurrent, resolveId, scpArgv, splitIdAndRest, sshTarget, sshTunnel, wakeIfArchived } from "./ssh";


/* ------------------------------ commands ------------------------------- */

/**
 * Time until auto-stop, or a dash when the ori is not counting down.
 *
 * The real CLI's `list` shows a "Time left" column instead of the ori type, and it is the
 * more useful thing to see: type is fixed for the ori's life, while time left is the number
 * that decides whether you need to `ori extend`. Its wording is borrowed too -- "no shutdown
 * scheduled" for a ori with no TTL.
 */
function timeLeft(b: any): string {
  const TERMINAL = ["archived", "archiving", "error"];
  if (TERMINAL.includes(b.state)) return "-";
  if (!b.archiveAfter) return "never";
  const ms = new Date(b.archiveAfter).getTime() - Date.now();
  if (ms <= 0) return "due";
  const mins = Math.floor(ms / 60_000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function fmtOris(oris: any[]): string {
  if (oris.length === 0) return "no oris";
  const header = ["ID", "STATE", "TIME LEFT", "SUBDOMAIN", "NAME"];
  const rows = oris.map((b) => [
    b.id,
    b.state,
    timeLeft(b),
    b.subdomain ?? "-",
    b.name ?? "",
  ]);
  const all = [header, ...rows];
  const w = [0, 1, 2, 3, 4].map((i) => Math.max(...all.map((r) => String(r[i]).length)));
  return all.map((r) => r.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd()).join("\n");
}

const USAGE = `ori — cloud sandboxes

usage: ori <command> [args] [--json]

  login <api-key>          store a key (also: ORI_API_KEY)
  status                   who am I, and is the control plane up
  new [--type T] [--ttl S] create a ori and wait for it to be ready
                           --display to allow the VNC desktop (off by default)
                           --env KEY=VALUE (repeatable) per-box env vars
                           --no-env to withhold account secrets (for user-facing oris)
  list                     list oris
  info <id>                one ori
  exec <id> <command...>   run a command in a ori (<=30s, --timeout N up to 60)
  ssh <id> [command...]    ssh in (interactive with no command)
  stop <id> [--force]      snapshot and archive
  delete <id> [--yes]      delete a STOPPED ori and its snapshot data, permanently
  resume <id> [--type T] [--no-env]  restore from the latest snapshot
  fork <id> [--no-env]     clone from the latest snapshot
  extend <id> [--hours N|--ttl S|--no-auto-stop]  change the auto-stop timer
  desktop <id> [--public]  open the VNC desktop in a browser
  events <id> [--follow]   read lifecycle events
  interrupt <id>           stop the agent working inside a ori
  snapshots [id]           list snapshots
  snapshot latest|tree|pull <id>  inspect or download a snapshot (works stopped)
  scp <src> <dst>          copy files; a side may be <id>:/path
  forward <id> --remote P  tunnel a TCP port from the ori to localhost
  host <id> <port>         expose a service on a public HTTPS URL (see ori host --help)
  prompt <id> ...          send a natural-language prompt to the agent in the ori
  limits                   usage, quota, and canStart
  dashboard                open the web dashboard
  config                   show the local config path and contents
  completions <shell>      completion script for bash|zsh|fish|powershell
  api-key list             list API keys (create/revoke live in the dashboard)
  logout                   forget the stored token
  rm-key                   forget the stored token
  version                  version, commit and platform
  update                   fetch and install the newest release over this binary

After ori new / ori fork, commands accept no id and act on the new ori when the shell
integration is installed (see scripts/shell-integration.sh).

  --json                   machine-readable output (JSONL)
  --debug                  log every request and its timing to stderr (also: ORI_DEBUG=1)
  --api-url URL            control plane (default ${DEFAULT_API})
  --version                same as \`ori version\``;

/** Where `ori update` fetches the installer from; overridable for a fork or a mirror. */
const INSTALL_URL = process.env.ORI_INSTALL_URL ?? "https://raw.githubusercontent.com/meta-boy/ori/main/install.sh";

/**
 * Poll until a ori is usable, then return — or die naming the state it got stuck in.
 *
 * Shared by `new` and `fork`. `fork` used to print success and exit 0 the moment the API
 * accepted it, while the restore ran on afterwards: a fork that failed reported
 * "forked from" and went to `error` five seconds later, so every script that forked then
 * acted was acting on a dead sandbox.
 *
 * 3s, not 1s: provisioning takes tens of seconds, so a one-second pulse spends up to 180
 * requests to learn something that changes maybe five times. The dots still move.
 */
async function waitUntilReady(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  id: string,
  initialState: string,
  verb: string,
): Promise<void> {
  if (!isJsonMode()) process.stderr.write(`${verb} ${id} `);
  const deadline = Date.now() + 180_000;
  let state = initialState;
  while (Date.now() < deadline && state !== "ready" && state !== "error") {
    await Bun.sleep(3000);
    if (!isJsonMode()) process.stderr.write(".");
    state = (await apiOk(cfg, "GET", `/oris/${id}`)).ori.state;
  }
  if (!isJsonMode()) process.stderr.write("\n");
  if (state !== "ready") die(`ori ${id} did not become ready (state ${state})`);
}

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  setModes(args.includes("--json"), args.includes("--debug") || process.env.ORI_DEBUG === "1");
  debug(`ori ${VERSION} (${COMMIT}) on ${process.platform}-${process.arch}`);
  const apiUrlIdx = args.indexOf("--api-url");
  let apiUrlOverride: string | undefined;
  if (apiUrlIdx >= 0) {
    apiUrlOverride = args[apiUrlIdx + 1];
    args.splice(apiUrlIdx, 2);
  }
  // Same shape as --api-url, and for the same reason: a flag's VALUE is not stripped by the
  // positional filter below, so `exec <id> --timeout 55 make` would otherwise send "55 make"
  // to the sandbox as the command.
  const timeoutIdx = args.indexOf("--timeout");
  let execTimeout: number | undefined;
  if (timeoutIdx >= 0) {
    execTimeout = Number(args[timeoutIdx + 1]);
    args.splice(timeoutIdx, 2);
    if (!Number.isInteger(execTimeout) || execTimeout < 1 || execTimeout > 60) {
      die("--timeout takes whole seconds, 1 to 60 (the server's cap). For longer work: ori ssh <id> '<command>'");
    }
  }
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  const cmd = positional[0];

  const cfg = await loadConfig();
  if (apiUrlOverride) cfg.apiUrl = apiUrlOverride;
  if (process.env.ORI_API_KEY) cfg.token = process.env.ORI_API_KEY;

  // Handled here rather than in the switch: flags never reach `cmd`, so a bare `ori --version`
  // would otherwise print the usage text — which is what it did.
  if (flags.has("--version")) {
    out(`ori ${VERSION} (${COMMIT}) ${process.platform}-${process.arch}`, {
      version: VERSION,
      commit: COMMIT,
      platform: `${process.platform}-${process.arch}`,
    });
    return;
  }

  const flagValue = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return;

    case "login": {
      const token = positional[1] ?? process.env.ORI_API_KEY;
      if (!token) die("usage: ori login <api-key>");
      await saveConfig({ apiUrl: cfg.apiUrl, token });
      // Verify rather than claiming success on an unchecked string.
      const me = await apiOk({ ...cfg, token }, "GET", "/me");
      out(`logged in as ${me.user?.login ?? "unknown"} (${CONFIG_PATH})`, { ok: true, user: me.user });
      return;
    }

    case "status": {
      // Sequential, NOT Promise.all. These reads are independent, but a CLI is a fresh process
      // with a cold connection pool, and against a Cloudflare-fronted control plane the TLS
      // handshake dominates the query: measured 124-204ms per request on a reused connection
      // versus 1.7-6.1s on some cold ones. Two parallel calls open two cold connections and
      // take two draws at that tail; sequential reuses the first. `status` was 1.6s median
      // (7.7s worst) while single-call `list` held 0.30s.
      const me = await apiOk(cfg, "GET", "/me");
      const limits = await apiOk(cfg, "GET", "/limits");
      out(
        `${me.user?.login ?? "?"} at ${cfg.apiUrl}\n` +
          `oris ${limits.activeOris}/${limits.maxActiveOris}  billing ${limits.billingStatus}`,
        { ok: true, user: me.user, limits },
      );
      return;
    }

    case "new": {
      const body: Record<string, unknown> = {};
      const type = flagValue("type");
      if (type) body.type = type;
      const ttl = flagValue("ttl");
      if (ttl) body.ttlSeconds = flags.has("--no-auto-stop") ? null : Number(ttl);
      if (flags.has("--no-auto-stop")) body.ttlSeconds = null;
      if (flags.has("--display")) body.display = true;
      if (flags.has("--no-env")) body.noEnv = true;
      // --env KEY=VALUE is repeatable; each pair becomes one per-box variable.
      const envEntries: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--env") {
          const pair = args[i + 1];
          const eqIdx = pair?.indexOf("=");
          if (!pair || eqIdx === undefined || eqIdx <= 0) die("usage: ori new --env KEY=VALUE (repeatable)");
          envEntries[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
          i++;
        }
      }
      if (Object.keys(envEntries).length > 0) body.env = envEntries;
      const created = await apiOk(cfg, "POST", "/oris", body);
      const id = created.ori.id;
      // Wait for ready: a ori you cannot use yet is not much of a result, and every other
      // command would just fail against it.
      await waitUntilReady(cfg, id, created.ori.state, "creating");
      await reportCurrent(id);
      out(`${id} ready`, { ok: true, id, state: "ready" });
      return;
    }

    case "list": {
      // --filter groups map Box's state-group letters onto ori states. The default is the
      // "up/running" group, matching `box list` (which defaults to `--filter r`).
      const FILTER_GROUPS: Record<string, string[]> = {
        r: ["ready", "cloning", "idle", "running"],
        s: ["archived"],
        p: ["init", "provisioning", "provisioned"],
        t: ["archiving"],
        e: ["error"],
      };
      let states: string[] | null = null;
      if (flags.has("--all")) states = null;
      else {
        const filter = flagValue("filter") ?? "r";
        const groups: string[] = [];
        for (const ch of filter) {
          const mapped = FILTER_GROUPS[ch];
          if (!mapped) die(`unknown --filter group "${ch}" (use r/s/p/t/e, e.g. --filter sr)`);
          groups.push(...mapped);
        }
        states = [...new Set(groups)];
      }
      const r = await apiOk(cfg, "GET", `/oris${states ? `?state=${encodeURIComponent(states.join(","))}` : ""}`);
      if (isJsonMode()) for (const b of r.oris) console.log(JSON.stringify(b));
      else console.log(fmtOris(r.oris));
      return;
    }

    case "info": {
      const id = resolveId(positional[1]) ?? die("usage: ori info <id> (or set ORI_CURRENT_ID)");
      const r = await apiOk(cfg, "GET", `/oris/${id}`);
      out(JSON.stringify(r.ori, null, 2), r.ori);
      return;
    }

    case "exec": {
      const { id: execId, rest: execRest } = splitIdAndRest(positional);
      const id = execId ?? die("usage: ori exec <id> <command...> (or set ORI_CURRENT_ID)");
      const command = execRest.join(" ");
      if (!command) die("usage: ori exec <id> <command...> (or set ORI_CURRENT_ID)");
      await wakeIfArchived(cfg, id);
      const r = await apiOk(cfg, "POST", `/oris/${id}/commands`, { command, ...(execTimeout ? { timeoutSeconds: execTimeout } : {}) });
      if (isJsonMode()) console.log(JSON.stringify(r));
      else {
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.stderr) process.stderr.write(r.stderr);
      }

      /*
       * A killed command must not look like a successful one.
       *
       * The guest reports a timeout as exitCode:null + timedOut:true, and `exitCode ?? 0` turned
       * that into a clean exit 0 — so `ori exec … && deploy` deployed after a build that was
       * killed at 30 seconds. Caller-visible silence is the worst failure a shell tool can have.
       *
       * 124 is what timeout(1) returns, and 128+n is the shell's convention for death by signal.
       */
      if (r.timedOut) {
        if (!isJsonMode()) {
          process.stderr.write(
            `ori: command killed after ${execTimeout ?? 30}s (server cap is 60s). For longer work: ori ssh ${id} '<command>'\n`,
          );
        }
        process.exit(124);
      }
      if (r.signal) {
        const SIGNUM: Record<string, number> = { SIGKILL: 9, SIGTERM: 15, SIGINT: 2, SIGSEGV: 11, SIGABRT: 6 };
        if (!isJsonMode()) {
          const hint = r.signal === "SIGKILL" ? " — often the machine type's memory ceiling; try a bigger --type" : "";
          process.stderr.write(`ori: command killed by ${r.signal}${hint}\n`);
        }
        process.exit(128 + (SIGNUM[r.signal] ?? 1));
      }
      // Propagate the ori's exit code: `ori exec … && next` must behave like a shell.
      process.exit(r.exitCode ?? 0);
    }

    // Internal: ssh's ProxyCommand. Not in USAGE — it is stdio plumbing, not a user command.
    case "ssh-tunnel": {
      const id = resolveId(positional[1]) ?? die("usage: ori ssh-tunnel <id>");
      await sshTunnel(cfg, id);
      return;
    }

    case "ssh": {
      const { id: sshId, rest } = splitIdAndRest(positional);
      const id = sshId ?? die("usage: ori ssh <id> [command...] (or set ORI_CURRENT_ID)");
      const { args: sshArgs } = await sshTarget(cfg, id);
      const p = Bun.spawn({
        cmd: ["ssh", ...sshArgs, ...rest],
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(await p.exited);
    }

    case "extend": {
      const id = resolveId(positional[1]) ?? die("usage: ori extend <id> [--hours N|--ttl S|--no-auto-stop]");
      const body: Record<string, unknown> = {};
      if (flags.has("--no-auto-stop")) {
        body.ttlSeconds = null;
      } else {
        const hours = flagValue("hours");
        const ttl = flagValue("ttl");
        if (hours !== undefined && ttl !== undefined) die("give one of --hours or --ttl, not both");
        if (hours !== undefined) {
          const h = Number(hours);
          if (!Number.isFinite(h) || h <= 0) die("--hours takes a positive number");
          body.ttlSeconds = Math.round(h * 3600);
        } else if (ttl !== undefined) {
          const s = Number(ttl);
          if (!Number.isInteger(s) || s < 1) die("--ttl takes whole seconds");
          body.ttlSeconds = s;
        } else {
          die("usage: ori extend <id> [--hours N|--ttl S|--no-auto-stop]");
        }
      }
      const r = await apiOk(cfg, "PATCH", `/oris/${id}`, body);
      out(`${id} auto-stop ${r.ori.archiveAfter ?? "disabled"}`, r);
      return;
    }

    case "stop": {
      const id = resolveId(positional[1]) ?? die("usage: ori stop <id> (or set ORI_CURRENT_ID)");
      const r = await apiOk(cfg, "POST", `/oris/${id}/stop`, { force: flags.has("--force") });
      out(`${id} ${r.status}`, r);
      return;
    }

    case "delete": {
      const id = resolveId(positional[1]) ?? die("usage: ori delete <id> (or set ORI_CURRENT_ID)");
      // Deleting destroys the snapshots too, and nothing else in the system does. A typed
      // confirmation is cheap next to data that cannot come back; --yes is for scripts.
      if (!flags.has("--yes") && !isJsonMode()) {
        process.stderr.write(`delete ${id} and ALL its snapshot data? this cannot be undone [y/N] `);
        const answer = (await new Response(Bun.stdin.stream()).text()).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") die("cancelled");
      }
      const r = await apiOk(cfg, "DELETE", `/oris/${id}`, undefined);
      out(`${id} deleted — ${r.snapshotsDeleted} snapshot(s), ${r.objectsDeleted} object(s) removed`, r);
      return;
    }

    case "resume": {
      const id = resolveId(positional[1]) ?? die("usage: ori resume <id> (or set ORI_CURRENT_ID)");
      const body: Record<string, unknown> = {};
      const type = flagValue("type");
      if (type) body.type = type;
      if (flags.has("--no-env")) body.noEnv = true;
      const r = await apiOk(cfg, "POST", `/oris/${id}/resume`, body);
      out(`${id} ${r.status}`, r);
      return;
    }

    case "fork": {
      const id = resolveId(positional[1]) ?? die("usage: ori fork <id> (or set ORI_CURRENT_ID)");
      const body: Record<string, unknown> = {};
      if (flags.has("--no-env")) body.noEnv = true;
      const r = await apiOk(cfg, "POST", `/oris/${id}/fork`, body);
      const forkedId = r.id ?? r.ori?.id;
      if (!forkedId) die("fork returned no ori id");
      // The restore runs after the API answers, so the fork is not usable yet and may still
      // fail. Poll like `new` does, and exit non-zero if it lands in error.
      await waitUntilReady(cfg, forkedId, r.ori?.state ?? "cloning", "forking");
      await reportCurrent(forkedId);
      out(`${forkedId} forked from ${id}`, { ...r, state: "ready" });
      return;
    }

    case "events": {
      const id = resolveId(positional[1]) ?? die("usage: ori events <id> [--follow]");
      const follow = flags.has("--follow");
      if (!follow) {
        // The newest 100, printed oldest-first: a long-lived ori has thousands of events and
        // the interesting ones are the recent ones.
        const r = await apiOk(cfg, "GET", `/oris/${id}/events?limit=100&sort=desc`);
        for (const e of (r.events ?? []).reverse()) console.log(isJsonMode() ? JSON.stringify(e) : fmtEvent(e));
        return;
      }
      // Follow: pageInfo.followCursor is positioned strictly after the last event of the
      // page, so each call returns only what arrived since — including on the last page,
      // where nextCursor is null.
      let cursor: string | null = null;
      for (;;) {
        const q = new URLSearchParams({ limit: "100", sort: "asc" });
        if (cursor) q.set("cursor", cursor);
        const r = await apiOk(cfg, "GET", `/oris/${id}/events?${q}`);
        for (const e of r.events ?? []) console.log(isJsonMode() ? JSON.stringify(e) : fmtEvent(e));
        cursor = r.pageInfo?.followCursor ?? cursor;
        if (!r.pageInfo?.hasMore) await Bun.sleep(1500);
      }
    }

    case "prompt": {
      // ori prompt <id> --provider codex|claude-code [--model M] [--reasoning-effort E] "<prompt>"
      // Flags' VALUES are consumed here (they would otherwise land in positional and become
      // part of the prompt text); everything else after the id is the prompt.
      let provider: string | undefined;
      let model: string | undefined;
      let effort: string | undefined;
      const rest: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--provider") { provider = args[++i]; continue; }
        if (a === "--model") { model = args[++i]; continue; }
        if (a === "--reasoning-effort") { effort = args[++i]; continue; }
        rest.push(a);
      }
      const id = resolveId(rest[1]) ?? die("usage: ori prompt <id> --provider codex|claude-code [--model M] [--reasoning-effort E] \"<prompt>\"");
      const promptText = rest.slice(2).join(" ").trim();
      if (!provider || !["codex", "claude-code", "claude"].includes(provider)) {
        die("--provider is required (codex | claude-code)");
      }
      if (!promptText) die("a non-empty prompt is required");

      const r = await apiOk(cfg, "POST", `/oris/${id}/prompt`, {
        provider,
        ...(model ? { model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        prompt: promptText,
      });
      const runId = r.promptId;
      if (isJsonMode()) {
        console.log(JSON.stringify({ event: "queued", data: { id, promptId: runId, status: "queued", provider, model: model ?? null, reasoningEffort: effort ?? null } }));
      } else {
        process.stderr.write(`queued ${runId}\n`);
      }

      // Stream: drain response events (taskId = run id) and poll the run until done. The run
      // is marked done BEFORE its last lines have necessarily been drained, so `finished`
      // buys one more pass rather than breaking on the spot and eating the tail.
      let cursor: string | null = null;
      let finished = false;
      for (;;) {
        const q = new URLSearchParams({ limit: "100", sort: "asc", type: "response" });
        if (cursor) q.set("cursor", cursor);
        const ev = await apiOk(cfg, "GET", `/oris/${id}/events?${q}`);
        for (const e of ev.events ?? []) {
          if (e.taskId !== runId) continue;
          const content = (e.data?.content ?? "") as string;
          if (isJsonMode()) {
            console.log(JSON.stringify({ event: "chat", final: e.data?.isStreaming === false, data: { type: "response", timestamp: e.timestamp, data: e.data } }));
          } else {
            process.stdout.write(content);
          }
        }
        cursor = ev.pageInfo?.followCursor ?? cursor;
        if (finished) break;
        finished = (await apiOk(cfg, "GET", `/oris/${id}/prompts/${runId}`)).promptRun.done;
        if (!finished) await Bun.sleep(1000);
      }
      if (!isJsonMode()) process.stdout.write("\n");
      return;
    }

    case "interrupt": {
      const id = resolveId(positional[1]) ?? die("usage: ori interrupt <id>");
      const r = await apiOk(cfg, "POST", `/oris/${id}/interrupt`, {});
      out(`${id} ${r.status ?? "interrupted"}`, r);
      return;
    }

    case "desktop": {
      const id = resolveId(positional[1]) ?? die("usage: ori desktop <id> (or set ORI_CURRENT_ID)");
      const r = await apiOk(cfg, "POST", `/oris/${id}/desktop`, {
        publicAccess: flags.has("--public"),
      });
      if (r.provisioning) {
        // The units are up but noVNC was not answering yet. Say so rather than handing over a
        // URL that shows a black screen.
        process.stderr.write("desktop still starting; the URL may need a moment\n");
      }
      out(r.desktopUrl, r);
      if (!isJsonMode() && !flags.has("--no-open")) {
        // Best effort: macOS `open`, Linux `xdg-open`. A failure here is not a failure of the
        // command — the URL is already printed.
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        try {
          Bun.spawn({ cmd: [opener, r.desktopUrl], stdout: "ignore", stderr: "ignore" });
        } catch {
          /* no opener; the URL is on stdout */
        }
      }
      return;
    }

    case "scp": {
      // ori scp <src> <dst> — either side may be `<id>:/path`. The id side is translated to
      // the same ssh target `ori ssh` uses (key, host-key alias, port or tunnel), so scp
      // works from anywhere the CLI does, no extra credentials.
      const parts = positional.slice(1);
      if (parts.length < 2) die("usage: ori scp <src> <dst> (one side: <id>:/path)");
      // `<id>:/path` or `current:/path`; the id shape is the canonical one from ssh.ts.
      const REMOTE_RE = new RegExp(`^(${ORI_ID_RE.source.slice(1, -1)}|current):(.+)$`);
      const targets = new Map<string, { args: string[] }>();
      const translated = await Promise.all(
        parts.map(async (p) => {
          const m = REMOTE_RE.exec(p);
          if (!m) return p;
          const id = resolveId(m[1]) ?? die("usage: ori scp ...");
          if (!targets.has(id)) targets.set(id, await sshTarget(cfg, id));
          const t = targets.get(id)!;
          const dest = t.args[t.args.length - 1]; // user@host (direct) or user@<id> (tunnel)
          return `${dest}:${m[2]}`;
        }),
      );
      const t0 = targets.values().next().value as { args: string[] } | undefined;
      const p = Bun.spawn({ cmd: ["scp", ...scpArgv(t0?.args ?? [""], translated)], stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.exit(await p.exited);
      return;
    }

    case "forward": {
      // TCP port forward through the same ssh transport `ori ssh` uses (direct or tunnel),
      // so it works from anywhere. `ssh -L` multiplexes over one connection.
      const id = resolveId(positional[1]) ?? die("usage: ori forward <id> --remote PORT [--local PORT] [--bind ADDR]");
      const remoteRaw = flagValue("remote");
      const remote = Number(remoteRaw);
      if (!Number.isInteger(remote) || remote < 1 || remote > 65535) die("--remote takes a port (1-65535)");
      const local = Number(flagValue("local") ?? remote);
      if (!Number.isInteger(local) || local < 1 || local > 65535) die("--local takes a port (1-65535)");
      const bind = flagValue("bind") ?? "127.0.0.1";
      const { args } = await sshTarget(cfg, id);
      out(`forwarding ${bind}:${local} -> ${id}:${remote} (ctrl-c to stop)`, { ok: true, bind, local, remote, oriId: id });
      const p = Bun.spawn({ cmd: ["ssh", ...args, "-N", "-L", `${bind}:${local}:localhost:${remote}`], stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.exit(await p.exited);
      return;
    }

    case "snapshots": {
      const id = positional[1];
      const r = await apiOk(cfg, "GET", id ? `/oris/${id}/snapshots` : "/snapshots");
      if (isJsonMode()) for (const s of r.snapshots) console.log(JSON.stringify(s));
      else if (r.snapshots.length === 0) console.log("no snapshots");
      else
        console.log(
          r.snapshots
            .map((s: any) => `${s.id}  gen ${s.generation}  ${s.kind}  ${s.sizeBytes}B  ${s.createdAt}`)
            .join("\n"),
        );
      return;
    }

    case "snapshot": {
      const sub = positional[1];
      if (sub === "latest") {
        const id = resolveId(positional[2]) ?? die("usage: ori snapshot latest <id>");
        const r = await apiOk(cfg, "GET", `/oris/${id}/snapshots/latest`);
        if (isJsonMode()) console.log(JSON.stringify(r.snapshot));
        else out(r.snapshot ? JSON.stringify(r.snapshot, null, 2) : "no snapshot yet", r.snapshot);
        return;
      }
      if (sub === "tree") {
        const snapshotIdArg = positional[2] ?? die("usage: ori snapshot tree <snapshotId>");
        const r = await apiOk(cfg, "GET", `/snapshots/${snapshotIdArg}/tree`);
        if (isJsonMode()) for (const e of r.entries) console.log(JSON.stringify(e));
        else
          console.log(
            (r.entries as Array<{ path: string; kind: string; size: number }>)
              .map((e) => `${e.kind === "dir" ? "d" : "-"} ${String(e.size).padStart(12)}  ${e.path}`)
              .join("\n"),
          );
        return;
      }
      if (sub === "pull") {
        // Download and reassemble: the work dir (home_user/) and docker volumes, streamed
        // straight out of the snapshot's restic repo as tars. Works while the ori is
        // stopped; never buffers the bytes through the control plane's JSON layer.
        const snapshotIdArg = positional[2] ?? die("usage: ori snapshot pull <snapshotId> [-o dir]");
        const oIdx = positional.indexOf("-o");
        const outDir = oIdx >= 0 ? positional[oIdx + 1] : "./restore";
        if (!outDir) die("usage: ori snapshot pull <snapshotId> [-o dir]");
        await mkdir(outDir, { recursive: true });
        for (const [label, path] of [["home_user", "home/user"], ["docker", "volumes"]] as const) {
          const target = join(outDir, label);
          await mkdir(target, { recursive: true });
          const res = await rawApi(cfg, "GET", `/snapshots/${snapshotIdArg}/files?path=${encodeURIComponent(path)}`);
          if (res.status === 404) continue; // volumes absent from this snapshot
          if (!res.ok) die(`snapshot pull: HTTP ${res.status} (${(await res.text()).slice(0, 300)})`);
          if (!isJsonMode()) process.stderr.write(`extracting ${label}...\n`);
          const tar = Bun.spawn({ cmd: ["tar", "-xzf", "-", "-C", target], stdin: "pipe", stdout: "ignore", stderr: "pipe" });
          const reader = res.body!.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) tar.stdin.write(value);
          }
          tar.stdin.end();
          const code = await tar.exited;
          if (code !== 0) die(`tar failed for ${label} (exit ${code})`);
        }
        out(`pulled ${snapshotIdArg} into ${outDir} (home_user/ + docker/)`, { ok: true, snapshotId: snapshotIdArg, outDir });
        return;
      }
      die("usage: ori snapshot latest <id> | tree <snapshotId> | pull <snapshotId> [-o dir]");
      return;
    }

    case "host": {
      // ori host <id> <port> [--title T] [--public|--private] — expose a service on a
      // stable HTTPS URL. Calls the public routes API (owner bearer auth); the same work the
      // in-box `host` CLI does over the machine-token channel.
      const id = resolveId(positional[1]) ?? die("usage: ori host <id> <port> [--title T] [--public]");
      const port = Number(positional[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) die("usage: ori host <id> <port>");
      const body: Record<string, unknown> = { port };
      const title = flagValue("title");
      if (title) body.title = title;
      if (flags.has("--public")) body.public = true;
      const r = await apiOk(cfg, "POST", `/oris/${id}/routes`, body);
      const url = r.token && !body.public ? `${r.url}?_token=${r.token}` : r.url;
      out(url, { ok: true, boxId: id, port, url, access: r.access, isProtected: r.isProtected, title: r.title ?? null });
      return;
    }

    case "limits": {
      const r = await apiOk(cfg, "GET", "/limits");
      if (isJsonMode()) {
        console.log(JSON.stringify(r));
      } else {
        console.log(
          `active oris ${r.activeOris}/${r.maxActiveOris}  starts/min ${r.creationRatePerMinute}  starts/day ${r.creationRequestsPerDay ?? "unlimited"}`,
        );
        console.log(`billing ${r.billingStatus}  credit ${r.creditBalanceSeconds}s  canStart ${r.canStart}`);
      }
      return;
    }

    case "dashboard": {
      // Open the web dashboard. Unlike Box, the CLI cannot pass its bearer key to the
      // browser (the dashboard's key path is a paste, not a URL fragment), so it opens the
      // dashboard and the user signs in or pastes the key there.
      const base = cfg.apiUrl.replace(/\/+$/, "");
      const url = `${base}/dashboard`;
      out(url, { ok: true, url });
      if (!isJsonMode()) {
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        try {
          Bun.spawn({ cmd: [opener, url], stdout: "ignore", stderr: "ignore" });
        } catch {
          /* no opener; the URL is on stdout */
        }
      }
      return;
    }

    case "config": {
      const cfgPath = CONFIG_PATH;
      const contents = await readFile(cfgPath, "utf8").catch(() => null);
      if (isJsonMode()) {
        console.log(JSON.stringify({ path: cfgPath, apiUrl: cfg.apiUrl, loggedIn: !!cfg.token, contents: contents ? JSON.parse(contents) : null }));
      } else {
        console.log(cfgPath);
        if (contents) console.log(contents);
      }
      return;
    }

    case "completions": {
      const shell = positional[1];
      const SCRIPT: Record<string, string> = {
        bash: `_ori_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "login status new list info exec ssh stop resume fork delete desktop snapshots snapshot extend events interrupt scp forward limits dashboard config completions api-key logout rm-key version update" -- "$cur") )
}
complete -F _ori_complete ori`,
        zsh: `#compdef ori
_ori() {
  local -a cmds
  cmds=(login status new list info exec ssh stop resume fork delete desktop snapshots snapshot extend events interrupt scp forward limits dashboard config completions api-key logout rm-key version update)
  _describe 'command' cmds
}
compdef _ori ori`,
        fish: `complete -c ori -f -a "login status new list info exec ssh stop resume fork delete desktop snapshots snapshot extend events interrupt scp forward limits dashboard config completions api-key logout rm-key version update"`,
        powershell: `Register-ArgumentCompleter -Native -CommandName ori -ScriptBlock {
  param($wordToComplete)
  'login','status','new','list','info','exec','ssh','stop','resume','fork','delete','desktop','snapshots','snapshot','extend','events','interrupt','scp','forward','limits','dashboard','config','completions','api-key','logout','rm-key','version','update' | Where-Object { $_ -like "$wordToComplete*" }
}`,
      };
      const script = SCRIPT[shell];
      if (!script) die("usage: ori completions bash|zsh|fish|powershell");
      console.log(script);
      return;
    }

    case "api-key": {
      const sub = positional[1];
      if (sub === "list") {
        const r = await apiOk(cfg, "GET", "/api-keys");
        if (isJsonMode()) for (const k of r.apiKeys) console.log(JSON.stringify(k));
        else
          console.log(
            (r.apiKeys as Array<{ id: string; name: string; keyPrefix: string; keyLastFour: string; createdAt: string }>)
              .map((k) => `${k.id}  ${k.name}  ${k.keyPrefix}…${k.keyLastFour}  ${k.createdAt}`)
              .join("\n") || "no api keys",
          );
        return;
      }
      // create/rotate/revoke are session-only by design (a leaked key must not mint keys);
      // the CLI authenticates with a key, so it cannot do them — the dashboard can.
      if (sub === "create" || sub === "revoke" || sub === "rotate") {
        die(`ori api-key ${sub} requires the dashboard sign-in (key lifecycle is session-only): open ${cfg.apiUrl}/dashboard`);
      }
      die("usage: ori api-key list");
      return;
    }

    case "logout":
    case "rm-key":
      await saveConfig({ apiUrl: cfg.apiUrl });
      out("token removed", { ok: true });
      return;

    case "version":
    case "--version":
      out(`ori ${VERSION} (${COMMIT}) ${process.platform}-${process.arch}`, {
        version: VERSION,
        commit: COMMIT,
        platform: `${process.platform}-${process.arch}`,
        apiUrl: cfg.apiUrl,
      });
      return;

    case "update": {
      // Delegates to the same installer a first-time user runs, rather than reimplementing
      // asset naming, checksums and install paths in a second place that can drift.
      out(`updating from ${VERSION} via ${INSTALL_URL}`);
      const script = await fetch(INSTALL_URL).then((r) => (r.ok ? r.text() : null));
      if (!script) die(`could not download the installer from ${INSTALL_URL}`);
      if (!script.startsWith("#!")) die(`${INSTALL_URL} did not return a script`);
      const p = Bun.spawn({
        cmd: ["bash", "-s", "--", ...(flags.has("--force") ? ["--force"] : [])],
        stdin: new TextEncoder().encode(script),
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(await p.exited);
    }

    default:
      die(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

await main(process.argv.slice(2));
