/**
 * The API client.
 *
 * Two credentials are supported, in this order:
 *
 *   1. A session cookie, set by /auth/login. The browser attaches it automatically, so nothing
 *      here has to hold it — which is the point: an API key in localStorage is readable by any
 *      XSS, and a HttpOnly cookie is not.
 *   2. A pasted API key, kept in localStorage. Retained because it is how this dashboard worked
 *      before sessions existed, and because it is the only way in before the first account.
 *
 * Every request is relative (`/api/ori/v1/...`), so the same build works on localhost and behind
 * a tunnel with no configuration.
 */

const KEY_STORAGE = "ori_api_key";

export function storedKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}
export function setStoredKey(k: string | null): void {
  try {
    if (k) localStorage.setItem(KEY_STORAGE, k);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* private mode */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/**
 * Nothing may wait forever.
 *
 * `fetch` has no default timeout, so a control plane that accepts the connection and then
 * stalls used to hang a button until the tab was reloaded. That is not hypothetical here:
 * resume and fork block server-side on a full restic restore, which on a multi-GB ori runs
 * for minutes.
 *
 * ponytail: one global ceiling, not per-endpoint timeouts. 75s clears the slowest endpoint with a
 * bounded answer (the server caps commands at 60s). It does NOT cover resume and fork, which block
 * on a full restic restore and can legitimately run for minutes — those WILL time out, by design.
 * That is safe because a timed-out request is safe to abandon: the server carries on, and every
 * mutation here is reflected in the state the list polls for. Callers that surface an
 * `ApiError.code === "timeout"` must say "still running", not "failed" — see `act` in Oris.tsx.
 */
const TIMEOUT_MS = 75_000;

async function request<T>(method: string, path: string, body?: unknown, base = "/api/ori/v1"): Promise<T> {
  const key = storedKey();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      // Send cookies even though the URL is same-origin — explicit so a future absolute base URL
      // does not silently drop the session.
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // A timeout and a dropped connection are both "we never got an answer" — give them a code
    // callers can branch on instead of a bare TypeError/DOMException.
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ApiError(0, "timeout", `${path} did not answer within ${TIMEOUT_MS / 1000}s`);
    }
    throw new ApiError(0, "offline", `Could not reach the control plane (${path})`);
  }

  // The body read is inside the same guard as the request. A connection that drops midway through
  // a response — the realistic failure for a long resume — throws here, not at `fetch`, and
  // without this it escaped as a bare TypeError past every caller that branches on `code`.
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ApiError(0, "timeout", `${path} did not answer within ${TIMEOUT_MS / 1000}s`);
    }
    throw new ApiError(0, "offline", `Connection dropped while reading ${path}`);
  }
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ApiError(res.status, undefined, `Malformed response from ${path}`);
    }
  }

  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(res.status, json.code as string | undefined, (json.message as string) ?? `Request failed (${res.status})`);
  }
  return json as T;
}

export const apiGet = <T = any>(path: string) => request<T>("GET", path);
export const apiPost = <T = any>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
export const apiPatch = <T = any>(path: string, body: unknown) => request<T>("PATCH", path, body);
export const apiPut = <T = any>(path: string, body: unknown) => request<T>("PUT", path, body);
export const apiDelete = <T = any>(path: string) => request<T>("DELETE", path);

/** /auth/* lives outside /api/ori/v1 — a login arrives without credentials. */
export const authPost = <T = any>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}, "/auth");
export const authGet = <T = any>(path: string) => request<T>("GET", path, undefined, "/auth");

export interface Ori {
  id: string;
  name: string;
  state: string;
  type: string;
  vcpu?: number;
  memoryGB?: number;
  ip?: string | null;
  subdomain?: string | null;
  createdAt: string;
  updatedAt?: string;
  archiveAfter?: string | null;
  ttlSeconds?: number | null;
  snapshotCompletedAt?: string | null;
  snapshotAvailable?: boolean;
}
