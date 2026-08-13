export type ErrorStatus =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 409
  | 429
  | 500
  | 502;

export interface ErrorDef {
  code: string;
  status: ErrorStatus;
  message: string;
}

const E = {
  // Covers a body that is absent, unparseable, OR well-formed JSON that fails schema
  // validation. There used to be a separate `invalid_body` for the last case, but the
  // spec has no such code: ori returns invalid_json for a body it will not accept, and
  // a client generated from ori's OpenAPI has no branch for anything else. See
  // docs/DIVERGENCES.md and packages/contract/test/divergences.test.ts.
  invalid_json: {
    code: "invalid_json",
    status: 400,
    message: "Request body is missing, malformed, or failed validation.",
  } satisfies ErrorDef,
  invalid_name: { code: "invalid_name", status: 400, message: "Name is invalid." } satisfies ErrorDef,
  invalid_env: { code: "invalid_env", status: 400, message: "Environment is invalid." } satisfies ErrorDef,
  invalid_subdomain: { code: "invalid_subdomain", status: 400, message: "Subdomain is invalid." } satisfies ErrorDef,
  subdomain_taken: { code: "subdomain_taken", status: 409, message: "Subdomain is already in use." } satisfies ErrorDef,
  prompt_required: { code: "prompt_required", status: 400, message: "prompt is required." } satisfies ErrorDef,
  machine_not_running: { code: "machine_not_running", status: 400, message: "The ori is not running." } satisfies ErrorDef,
  type_too_small: { code: "type_too_small", status: 400, message: "The ori's data would not fit the smaller disk." } satisfies ErrorDef,

  unauthorized: { code: "unauthorized", status: 401, message: "Unauthorized" } satisfies ErrorDef,
  forbidden: { code: "forbidden", status: 403, message: "Forbidden" } satisfies ErrorDef,
  billing_required: { code: "billing_required", status: 402, message: "Payment required." } satisfies ErrorDef,
  not_found: { code: "not_found", status: 404, message: "Not found" } satisfies ErrorDef,

  provider_not_configured: { code: "provider_not_configured", status: 409, message: "Prompting is locked until Codex is configured on the Agents page." } satisfies ErrorDef,
  ori_not_promptable: { code: "ori_not_promptable", status: 409, message: "The ori cannot be prompted right now." } satisfies ErrorDef,
  resume_failed: { code: "resume_failed", status: 409, message: "Resume failed." } satisfies ErrorDef,
  ori_restoring: { code: "ori_restoring", status: 409, message: "The ori is restoring and not yet reachable." } satisfies ErrorDef,
  display_disabled: { code: "display_disabled", status: 409, message: "This ori was created without a display. Create one with display: true." } satisfies ErrorDef,
  ori_not_deletable: { code: "ori_not_deletable", status: 409, message: "Stop the ori before deleting it." } satisfies ErrorDef,

  rate_limited: { code: "rate_limited", status: 429, message: "Rate limit exceeded." } satisfies ErrorDef,
  start_limit_reached: { code: "start_limit_reached", status: 429, message: "Machine start limit reached." } satisfies ErrorDef,
  daily_limit_reached: { code: "daily_limit_reached", status: 429, message: "Daily creation limit reached." } satisfies ErrorDef,
  // Documented in Box's error table ("limit_reached: Concurrent box limit reached") but absent
  // from our spec's examples; used by the hosted-port cap. Declared in docs/DIVERGENCES.md.
  limit_reached: { code: "limit_reached", status: 429, message: "Limit reached." } satisfies ErrorDef,

  invalid_json_response: { code: "invalid_json_response", status: 500, message: "Invalid JSON response from provider." } satisfies ErrorDef,
  stream_failed: { code: "stream_failed", status: 500, message: "Agent stream failed." } satisfies ErrorDef,
  internal_error: { code: "internal_error", status: 500, message: "Internal server error." } satisfies ErrorDef,
  gateway_error: { code: "gateway_error", status: 502, message: "Gateway error." } satisfies ErrorDef,

  legacy_snapshot: { code: "legacy_snapshot", status: 409, message: "Pre-inventory snapshot." } satisfies ErrorDef,
  snapshot_not_indexed: { code: "snapshot_not_indexed", status: 409, message: "Content captured before the indexed snapshot format." } satisfies ErrorDef,
  base_image_file: { code: "base_image_file", status: 409, message: "Stock image file, not stored in snapshots." } satisfies ErrorDef,
  is_symlink: { code: "is_symlink", status: 409, message: "Path is a symlink; request its target instead." } satisfies ErrorDef,
  inventory_too_large: { code: "inventory_too_large", status: 409, message: "Snapshot inventory is too large to expand." } satisfies ErrorDef,
} satisfies Record<string, ErrorDef>;

export type ErrorCode = keyof typeof E;

export const ERROR_CODES = Object.keys(E) as ErrorCode[];
export const ERRORS: Record<ErrorCode, ErrorDef> = E;

export interface ApiError extends ErrorDef {
  details?: Record<string, unknown>;
  requestId?: string;
}

export function errorOf(code: ErrorCode): ErrorDef {
  return E[code];
}

/** Validate that a status/code pair matches the documented mapping. */
export function isCorrectStatus(code: string, status: number): boolean {
  const def = E[code as ErrorCode];
  return !!def && def.status === status;
}

/** Build a full ApiError. */
export function apiError(
  code: ErrorCode,
  opts: { message?: string; details?: Record<string, unknown>; requestId?: string } = {},
): ApiError {
  const def = E[code];
  return { ...def, message: opts.message ?? def.message, ...(opts.details ? { details: opts.details } : {}), ...(opts.requestId ? { requestId: opts.requestId } : {}) };
}