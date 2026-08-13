import { apiError, type ErrorCode } from "./errors";
import { requestId } from "./ids";

/** Success envelope: `{ok:true, type:<noun.verb>, ...payload}`. */
export function ok(type: string, payload: Record<string, unknown> = {}): object {
  return { ok: true, type, ...payload };
}

export interface ApiFailDetails {
  message?: string;
  details?: Record<string, unknown>;
}

/** Error envelope: the documented `ori.error` shape with a fresh requestId. */
export function fail(
  status: number,
  code: ErrorCode,
  message?: string,
  details?: Record<string, unknown>,
): object {
  const err = apiError(code, { message, details });
  return {
    ok: false,
    type: "ori.error",
    status,
    code: err.code,
    message: err.message,
    requestId: requestId(),
    error: {
      code: err.code,
      message: err.message,
      status: err.status,
      ...(details ? { details } : {}),
    },
  };
}

export interface PageInfoShape {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface PaginateArgs<T> {
  rows: T[];
  limit: number;
  cursor: string | null;
  encodeCursor: (row: T) => string;
}

/**
 * Pure pager over rows already fetched as `limit + 1` (one probe row past the page).
 * Returns the trimmed page and the documented `pageInfo`.
 *
 * `nextCursor` is the LAST row of the page just returned, and it is EXCLUSIVE:
 * callers filter strictly past it (`< cursor` descending, `> cursor` ascending).
 *
 * Do NOT set it to the probe row `rows[limit]`. That is the first row of the *next*
 * page, so every strict-comparison call site excluded it and silently dropped one
 * row at every page boundary — GET /oris omitted real oris from the list, which
 * makes them unreachable while they keep billing. If you ever want an inclusive
 * cursor, every call site has to move to `<=` in the same commit.
 */
export function paginate<T>(args: PaginateArgs<T>): { page: T[]; pageInfo: PageInfoShape } {
  const { rows, limit, encodeCursor } = args;
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page.length > 0 ? (page[page.length - 1] as T) : undefined;
  const nextCursor = hasMore && last !== undefined ? encodeCursor(last) : null;
  return { page, pageInfo: { nextCursor, hasMore, limit } };
}