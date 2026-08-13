import type { MiddlewareHandler } from "hono";
import { requestId as newRequestId, requestIdRegex } from "@ori/contract";

/**
 * Sets a `req_…` request id on every request (echoed in error envelopes) and
 * reflects it in the `X-Request-Id` response header. Honors an inbound
 * well-formed `x-request-id`.
 */
export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const inbound = c.req.header("x-request-id");
    const id =
      inbound && requestIdRegex.test(inbound) ? inbound : newRequestId();
    c.set("requestId", id);
    c.header("X-Request-Id", id);
    await next();
  };
}