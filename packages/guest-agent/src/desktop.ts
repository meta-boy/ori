/**
 * POST /desktop/start and /desktop/stop — bring the VNC desktop up on demand.
 *
 * The image installs xvfb, openori, x11vnc and noVNC as systemd units that are deliberately
 * NOT enabled (image/provision.sh): a desktop costs memory and almost no ori wants one, so it
 * starts lazily. Starting novnc.service is enough — it Requires x11vnc which Requires xvfb,
 * and xvfb Wants openori, so the whole chain comes up from one call. Verified: starting only
 * novnc yields all four active.
 *
 * This does not authenticate anything. x11vnc runs -nopw bound to 127.0.0.1 inside the ori,
 * and the ONLY thing standing between a caller and someone else's desktop is the control
 * plane's signed token plus the fact that 6080 is never published beyond loopback. Do not
 * "simplify" either of those away.
 */

export const DESKTOP_PORT = 6080;
const UNIT = "novnc.service";
const CHAIN = ["xvfb.service", "openori.service", "x11vnc.service", "novnc.service"] as const;

export interface DesktopRunner {
  (cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

async function run(cmd: string[], runner?: DesktopRunner, timeoutMs = 30_000) {
  if (runner) return runner(cmd);
  let proc;
  try {
    proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  } catch {
    return { code: -1, stdout: "", stderr: "spawn failed" };
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

export interface DesktopStatus {
  ok: boolean;
  port: number;
  /** Per-unit active state, so a half-started chain is visible rather than a bare failure. */
  units: Record<string, string>;
  /** True when noVNC is answering; the caller should not hand out a URL before this. */
  ready: boolean;
  error?: string;
}

async function unitStates(runner?: DesktopRunner): Promise<Record<string, string>> {
  const states: Record<string, string> = {};
  for (const u of CHAIN) {
    const r = await run(["systemctl", "is-active", u], runner, 10_000);
    states[u] = r.stdout.trim() || "unknown";
  }
  return states;
}

/** Is noVNC actually serving? A unit reporting active is not the same as a socket answering. */
async function serving(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/vnc.html`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startDesktop(runner?: DesktopRunner): Promise<DesktopStatus> {
  const started = await run(["systemctl", "start", UNIT], runner, 60_000);
  const units = await unitStates(runner);
  if (started.code !== 0) {
    return {
      ok: false,
      port: DESKTOP_PORT,
      units,
      ready: false,
      error: `systemctl start ${UNIT} failed: ${started.stderr.trim() || started.code}`,
    };
  }

  // Poll rather than assume. Xvfb has no readiness signal and x11vnc retries against it, so
  // "active" can precede "usable" by a second or two; handing out a URL in that window gives
  // the user a black screen and a support question.
  let ready = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await serving(DESKTOP_PORT)) {
      ready = true;
      break;
    }
    await Bun.sleep(400);
  }
  return { ok: true, port: DESKTOP_PORT, units: await unitStates(runner), ready };
}

export async function stopDesktop(runner?: DesktopRunner): Promise<DesktopStatus> {
  // Stop the whole chain, newest first, so Xvfb does not linger holding a display.
  for (const u of [...CHAIN].reverse()) await run(["systemctl", "stop", u], runner, 30_000);
  return { ok: true, port: DESKTOP_PORT, units: await unitStates(runner), ready: false };
}
