import { describe, expect, test } from "bun:test";
import {
  assertValidResponse,
  assertErrorEnvelope,
  collectJsonExamples,
  loadOpenApi,
} from "./harness";

describe("openapi examples conformance", () => {
  const doc = loadOpenApi();
  const examples = collectJsonExamples(doc);

  test("spec loads and exposes paths", () => {
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    expect(Object.keys(doc.components.schemas).length).toBeGreaterThan(0);
  });

  test("collects a non-trivial set of JSON response examples", () => {
    // We expect every documented 2xx JSON example across the 28 mapped operations.
    expect(examples.length).toBeGreaterThan(15);
  });

  test("every JSON response example in the spec validates against the contract schema", () => {
    for (const ex of examples) {
      expect(
        () => assertValidResponse(ex.operationId, ex.value),
        `operationId=${ex.operationId} example=${ex.label} must validate`,
      ).not.toThrow();
    }
  });

  test("registers a schema for every JSON operation that carries an example", () => {
    const registered = new Set(
      examples.map((e) => e.operationId),
    );
    // Operations whose 2xx in the spec includes an example value. The six
    // operations without examples (update, promptRunStatus, readFile, writeFile,
    // command, listOriSnapshots) are validated via dedicated unit tests instead.
    const expected = new Set([
      "me",
      "limits",
      "repos",
      "selectRepo",
      "apiKeys",
      "secrets",
      "updateSecrets",
      "oris",
      "create",
      "get",
      "stop",
      "resume",
      "fork",
      "prompt",
      "events",
      "interrupt",
      "desktop",
      "sshKey",
      "listSnapshots",
      "getLatestOriSnapshot",
      "getSnapshotTree",
      "getSnapshotDownload",
    ]);
    expect(registered).toEqual(expected);
  });
});

describe("error envelope validation", () => {
  test("accepts a documented error envelope", () => {
    assertErrorEnvelope({
      ok: false,
      type: "ori.error",
      status: 400,
      code: "invalid_json",
      message: "Request body must be valid JSON.",
      requestId: "req_01HXEXAMPLE",
      error: { code: "invalid_json", message: "Request body must be valid JSON.", status: 400 },
    });
  });

  test("rejects a success-shaped body as an error envelope", () => {
    expect(() => assertErrorEnvelope({ ok: true, type: "ori.info" })).toThrow();
  });

  test("rejects a missing error sub-object", () => {
    expect(() =>
      assertErrorEnvelope({ ok: false, type: "ori.error", status: 400, code: "x", message: "m", requestId: "r" }),
    ).toThrow();
  });
});