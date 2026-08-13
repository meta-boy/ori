import { describe, expect, test } from "bun:test";
import {
  ERRORS,
  ERROR_CODES,
  errorOf,
  isCorrectStatus,
  apiError,
  type ErrorCode,
} from "../src/errors";

describe("error code registry", () => {
  test("every documented code maps to its pinned status (§4)", () => {
    expect(errorOf("invalid_json").status).toBe(400);
    expect(errorOf("prompt_required").status).toBe(400);
    expect(errorOf("invalid_name").status).toBe(400);
    expect(errorOf("invalid_env").status).toBe(400);
    expect(errorOf("machine_not_running").status).toBe(400);
    expect(errorOf("type_too_small").status).toBe(400);

    expect(errorOf("unauthorized").status).toBe(401);
    expect(errorOf("forbidden").status).toBe(403);
    expect(errorOf("billing_required").status).toBe(402);
    expect(errorOf("not_found").status).toBe(404);

    expect(errorOf("provider_not_configured").status).toBe(409);
    expect(errorOf("ori_not_promptable").status).toBe(409);
    expect(errorOf("resume_failed").status).toBe(409);
    expect(errorOf("ori_restoring").status).toBe(409);

    expect(errorOf("rate_limited").status).toBe(429);
    expect(errorOf("start_limit_reached").status).toBe(429);
    expect(errorOf("daily_limit_reached").status).toBe(429);
  });

  test("codes are unique", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  test("every status is a documented HTTP error status", () => {
    const valid = new Set([400, 401, 402, 403, 404, 409, 429, 500, 502]);
    for (const c of ERROR_CODES) {
      expect(valid.has(ERRORS[c].status)).toBe(true);
    }
  });

  test("isCorrectStatus validates pairs", () => {
    expect(isCorrectStatus("not_found", 404)).toBe(true);
    expect(isCorrectStatus("not_found", 400)).toBe(false);
    expect(isCorrectStatus("unknown_code", 404)).toBe(false);
  });

  test("all error codes exposed match the registry", () => {
    for (const c of ERROR_CODES) {
      expect(ERRORS[c as ErrorCode]).toBeDefined();
      expect(errorOf(c as ErrorCode).code).toBe(c);
    }
  });
});

describe("apiError", () => {
  test("builds a full error with default message", () => {
    const e = apiError("type_too_small");
    expect(e.code).toBe("type_too_small");
    expect(e.status).toBe(400);
    expect(typeof e.message).toBe("string");
    expect(e.message.length).toBeGreaterThan(0);
  });

  test("override message and details", () => {
    const e = apiError("invalid_env", {
      message: "nope",
      details: { count: 5 },
      requestId: "req_x",
    });
    expect(e.message).toBe("nope");
    expect(e.details).toEqual({ count: 5 });
    expect(e.requestId).toBe("req_x");
  });

  test("does not include optional keys when omitted", () => {
    const e = apiError("unauthorized");
    expect("details" in e).toBe(false);
    expect("requestId" in e).toBe(false);
  });
});