import type { ErrorCode } from "@ori/contract";

/**
 * Control-plane → guest-agent HTTP client. The guest agent listens on :7777
 * inside every ori and authenticates with the per-ori agent token. The fake
 * driver serves the same API over loopback, so this client works against both.
 */
export interface GuestHealth {
  ok: boolean;
  oriId: string;
  uptimeSeconds: number;
  diskUsedBytes: number;
}

/**
 * The guest either took a snapshot or declined to, and the caller has to be able to tell which.
 *
 * A decline is not an error: the guest's change-detection probe found nothing had moved since
 * the last successful snapshot, so there was nothing to back up. Modelling it here rather than
 * having callers cast the payload to read one field is what lets `takeSnapshot` narrow on
 * `type` and keeps the two shapes from being confused for one another.
 */
export type GuestSnapshotResult = GuestSnapshotCreated | GuestSnapshotSkipped;

export interface GuestSnapshotCreated {
  /** Optional so a guest agent predating the skip outcome still parses as "created". */
  type?: "snapshot.created";
  snapshotId: string;
  generation: number;
  sizeBytes: number;
  fileCount: number;
  createdAt: string;
}

export interface GuestSnapshotSkipped {
  type: "snapshot.skipped";
  reason?: string;
}

/** Control-plane-minted storage for one guest /snapshot call. Never logged. */
export interface GuestSnapshotStorage {
  repoUrl: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  region?: string;
  password: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
}

export interface GuestFileRead {
  ok: boolean;
  path: string;
  encoding: "utf8" | "base64";
  size: number;
  content: string;
}

export interface GuestFileWrite {
  ok: boolean;
  path: string;
  encoding: "utf8" | "base64";
  size: number;
}

/**
 * Error thrown when a guest-agent call fails. `status` is the guest's HTTP
 * status, or 0 when the guest could not be reached at all (transport failure).
 * The control plane translates this into a documented envelope code — never
 * lets the guest's internal `{ok:false,error}` body reach a client.
 */
export class GuestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GuestError";
  }
}

/**
 * Map a GuestError (or any thrown value) onto a documented envelope code the
 * routes use with `fail()`. A guest 400 is an invalid request; 404 is a
 * missing resource; anything else — including an unreachable agent — is a
 * gateway failure. `invalidMessage`, when given, overrides the message for the
 * 400 case; otherwise the guest's own message is carried through.
 */
export function translateGuestError(
  e: unknown,
  invalidMessage?: string,
): { status: 400 | 404 | 502 | 500; code: ErrorCode; message?: string } {
  if (e instanceof GuestError) {
    if (e.status === 400) return { status: 400, code: "invalid_json", message: invalidMessage ?? e.message };
    if (e.status === 404) return { status: 404, code: "not_found" };
    return { status: 502, code: "gateway_error" };
  }
  return { status: 500, code: "internal_error" };
}

export class GuestClient {
  private baseUrl: string;

  constructor(
    baseUrl: string,
    private agentToken: string,
  ) {
    this.baseUrl = baseUrl;
  }

  /**
   * Build a client for a ori. The fake driver reports `ip` as
   * `127.0.0.1:<port>`; a real host reports a plain IPv4, so append :7777.
   */
  static forIp(ip: string, agentToken: string): GuestClient {
    const base = ip.includes(":") ? `http://${ip}` : `http://${ip}:7777`;
    return new GuestClient(base, agentToken);
  }

  /** Fetch and throw GuestError(0) on transport failure; otherwise the raw Response. */
  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.agentToken}`,
          // No keep-alive pooling: each call opens a fresh connection so a
          // destroyed/unreachable agent fails loudly instead of reusing a stale
          // pooled connection to a dead VM.
          connection: "close",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new GuestError(0, `guest ${method} ${path}: unreachable (${(e as Error).message})`);
    }
    return res;
  }

  /** Throw a GuestError carrying the guest's status + error message for a non-ok response. */
  private async ensureOk(res: Response, method: string, path: string): Promise<void> {
    if (!res.ok) {
      let message = `guest ${method} ${path}: HTTP ${res.status}`;
      try {
        const errorBody = (await res.json()) as { error?: string };
        if (typeof errorBody?.error === "string") message = errorBody.error;
      } catch {
        // non-JSON error body; keep the HTTP fallback
      }
      throw new GuestError(res.status, message);
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    await this.ensureOk(res, method, path);
    return (await res.json()) as T;
  }

  async health(): Promise<GuestHealth> {
    return this.request("GET", "/health");
  }

  /**
   * `storage` is REQUIRED by the guest: it holds the scoped S3 credentials and the derived
   * repo password the control plane mints per call (§5 amendment — the ori keeps no durable
   * credential). Sending only { mode } made the guest reject the request, which meant every
   * final snapshot failed and, because stop refuses on a failed final snapshot, every ori
   * would have been left running and unbilled. Callers should go through
   * snapshots/take.ts rather than calling this directly.
   */
  async snapshot(mode: "auto" | "final", storage: GuestSnapshotStorage): Promise<GuestSnapshotResult> {
    return this.request("POST", "/snapshot", { mode, storage });
  }

  /**
   * `storage` is REQUIRED, exactly as for snapshot(). Omitting it made the guest reject the
   * request, which would have failed every resume and every fork. Go through
   * snapshots/take.ts#restoreSnapshot rather than calling this directly.
   */
  async restore(
    snapshotRef: string,
    scrubEnv: boolean,
    storage: GuestSnapshotStorage,
  ): Promise<{ ok: boolean }> {
    return this.request("POST", "/restore", { snapshotRef, scrubEnv, storage });
  }

  /** Bring the lazy VNC desktop up inside the ori. */
  async desktopStart(): Promise<{ ok: boolean; port: number; ready: boolean; units: Record<string, string>; error?: string }> {
    return this.request("GET", "/desktop/start");
  }

  /**
   * Step the guest's system clock to the given epoch (post-snapshot-resume): a resumed
   * VM wakes with its clock frozen at suspend time, and the control plane steps it
   * forward so timestamps inside the ori keep making sense.
   */
  async clock(epochMs: number): Promise<{ ok: boolean; steppedMs: number }> {
    return this.request("POST", "/clock", { epochMs });
  }

  /**
   * Tear the VNC desktop back down. The units are lazy by design, so a desktop nobody is
   * watching is pure waste: Xvfb, the window manager, the file manager and x11vnc all keep
   * running under software GL with screen blanking disabled until something stops them.
   */
  async desktopStop(): Promise<{ ok: boolean; units?: Record<string, string> }> {
    return this.request("GET", "/desktop/stop");
  }

  /** Authorise an OpenSSH public key on the ori. */
  async sshkey(key: string): Promise<{ ok: boolean; sshUser: string; keyCount: number; alreadyPresent: boolean }> {
    return this.request("POST", "/sshkey", { key });
  }

  /** Execute a command in the ori; returns the command.finished body verbatim. */
  async exec(req: { command: string; cwd?: string; timeoutSeconds?: number }): Promise<Record<string, unknown>> {
    return this.request("POST", "/exec", req);
  }

  /** Read a file from the ori's work dir. */
  async readFile(path: string, encoding: string): Promise<GuestFileRead> {
    return this.request("GET", `/file?path=${encodeURIComponent(path)}&encoding=${encoding}`);
  }

  /** Write a file in the ori's work dir. */
  async writeFile(req: { path: string; content: string; encoding?: string }): Promise<GuestFileWrite> {
    return this.request("PUT", "/file", req);
  }

  /** Push the ori's effective environment: /etc/ori.env vars + secret files under the work dir. */
  async env(vars: Record<string, string>, files: { path: string; contents: string }[]): Promise<{ ok: boolean }> {
    return this.request("POST", "/env", { vars, files });
  }

  /** Start a provider CLI (codex / claude-code) run inside the ori. */
  async prompt(req: {
    promptId: string;
    provider: string;
    model?: string | null;
    reasoningEffort?: string | null;
    prompt: string;
  }): Promise<Record<string, unknown>> {
    return this.request("POST", "/prompt", req);
  }

  /** Read a prompt run's state plus any newly captured lines since `from`. */
  async promptStatus(promptId: string, from: number): Promise<{
    ok: boolean;
    promptId: string;
    provider: string;
    status: string;
    done: boolean;
    exitCode: number | null;
    error: string | null;
    lineCount: number;
    lines: { stream: string; text: string }[];
  }> {
    return this.request("GET", `/prompt/${encodeURIComponent(promptId)}/status?from=${from}`);
  }

  /** Interrupt the currently running agent work in the ori. */
  async interrupt(): Promise<{ ok: boolean; interrupted: boolean }> {
    return this.request("POST", "/interrupt", {});
  }

  /**
   * Stream an artifact out of the ori: a file's bytes, or a folder as a tar.
   * Returns the raw Response so the caller can relay the body without
   * buffering it; throws GuestError on an error response.
   */
  async artifact(path: string): Promise<Response> {
    const res = await this.raw("GET", `/artifact?path=${encodeURIComponent(path)}`);
    await this.ensureOk(res, "GET", "/artifact");
    return res;
  }
}
