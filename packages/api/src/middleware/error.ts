import type { ErrorHandler, NotFoundHandler } from "hono";
import { fail, type ErrorCode } from "@ori/contract";
import type { AppEnv } from "../context";

type C = { get: <K extends keyof AppEnv["Variables"]>(k: K) => AppEnv["Variables"][K] };

/** Build the `ori.error` envelope, overriding the requestId with the middleware's. */
function envelope(c: C, status: number, code: ErrorCode, message?: string) {
  const body = fail(status, code, message) as {
    ok: false;
    type: "ori.error";
    requestId: string;
  };
  body.requestId = c.get("requestId");
  return {
    status: status as 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500,
    body,
  };
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
  const { status, body } = envelope(c, 404, "not_found");
  return c.json(body, status);
};

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof SyntaxError) {
    const { status, body } = envelope(
      c,
      400,
      "invalid_json",
      "Request body must be valid JSON.",
    );
    return c.json(body, status);
  }
  const { status, body } = envelope(c, 500, "internal_error");
  return c.json(body, status);
};