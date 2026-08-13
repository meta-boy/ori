import { describe, expect, test } from "bun:test";
import { ok, fail, paginate, type PageInfoShape } from "../src/envelope";
import { requestIdRegex } from "../src/ids";

describe("ok()", () => {
  test("builds a success envelope with ok:true and the type", () => {
    const env = ok("ori.created", { id: "or_23456789" }) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.type).toBe("ori.created");
    expect(env.id).toBe("or_23456789");
  });

  test("works without payload", () => {
    const env = ok("user.info") as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.type).toBe("user.info");
  });
});

describe("fail()", () => {
  test("produces the documented error envelope shape", () => {
    const env = fail(400, "invalid_json") as Record<string, any>;
    expect(env.ok).toBe(false);
    expect(env.type).toBe("ori.error");
    expect(env.status).toBe(400);
    expect(env.code).toBe("invalid_json");
    expect(typeof env.message).toBe("string");
    expect(typeof env.requestId).toBe("string");
    expect(requestIdRegex.test(env.requestId)).toBe(true);
    expect(env.error.code).toBe("invalid_json");
    expect(env.error.message).toBe(env.message);
    expect(env.error.status).toBe(400);
  });

  test("carries custom message and details", () => {
    const env = fail(429, "rate_limited", "too fast", { window: "1m" }) as Record<string, any>;
    expect(env.message).toBe("too fast");
    expect(env.error.message).toBe("too fast");
    expect(env.error.details).toEqual({ window: "1m" });
  });

  test("status mirrors the error code's pinned status even if mismatched", () => {
    // fail(status,...) keeps top-level status as passed; code carries its own def
    const env = fail(404, "not_found") as Record<string, any>;
    expect(env.status).toBe(404);
    expect(env.error.status).toBe(404);
  });

  test("generates a fresh requestId each call", () => {
    const a = fail(400, "invalid_json") as Record<string, string>;
    const b = fail(400, "invalid_json") as Record<string, string>;
    expect(a.requestId).not.toBe(b.requestId);
  });
});

describe("paginate()", () => {
  const enc = (x: number) => `cursor:${x}`;

  test("page with more rows yields hasMore and nextCursor", () => {
    const rows = [1, 2, 3, 4];
    const { page, pageInfo } = paginate({ rows, limit: 3, cursor: null, encodeCursor: enc });
    expect(page).toEqual([1, 2, 3]);
    expect(pageInfo.hasMore).toBe(true);
    expect(pageInfo.nextCursor).toBe("cursor:3"); // last row of THIS page, exclusive; "cursor:4" was the probe row and dropped row 4
    expect(pageInfo.limit).toBe(3);
  });

  test("page exactly at limit has no next page", () => {
    const rows = [1, 2, 3];
    const { page, pageInfo } = paginate({ rows, limit: 3, cursor: null, encodeCursor: enc });
    expect(page).toEqual([1, 2, 3]);
    expect(pageInfo.hasMore).toBe(false);
    expect(pageInfo.nextCursor).toBeNull();
  });

  test("empty rows", () => {
    const { page, pageInfo } = paginate({ rows: [], limit: 3, cursor: null, encodeCursor: enc });
    expect(page).toEqual([]);
    expect(pageInfo).toEqual({ nextCursor: null, hasMore: false, limit: 3 });
  });

  test("keeps the documented PageInfo keys exactly", () => {
    const { pageInfo } = paginate({ rows: [1], limit: 1, cursor: null, encodeCursor: enc });
    const keys = Object.keys(pageInfo).sort();
    expect(keys).toEqual(["hasMore", "limit", "nextCursor"]);
    const shape: PageInfoShape = pageInfo;
    expect(typeof shape.hasMore).toBe("boolean");
    expect(typeof shape.limit).toBe("number");
  });
});