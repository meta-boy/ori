import { describe, expect, test } from "bun:test";
import { loadOpenApi } from "./harness";

const JSON_OPERATIONS = new Set([
  "me", "limits", "repos", "selectRepo", "apiKeys", "secrets", "updateSecrets",
  "oris", "create", "get", "update", "stop", "resume", "fork", "prompt", "events",
  "promptRunStatus", "readFile", "writeFile", "command", "interrupt", "desktop",
  "sshKey", "listSnapshots", "listOriSnapshots", "getLatestOriSnapshot",
  "getSnapshotTree", "getSnapshotDownload",
]);
const BINARY_OPERATIONS = new Set(["artifact", "getSnapshotFile"]);

describe("OpenAPI surface coverage", () => {
  const doc = loadOpenApi();

  test("path count is stable at 25 paths (plan estimated 31)", () => {
    expect(Object.keys(doc.paths)).toHaveLength(25);
  });

  test("operation count is stable at 30 operations", () => {
    let n = 0;
    for (const [, methods] of Object.entries(doc.paths)) {
      for (const m of ["get", "post", "put", "patch", "delete", "head", "options"]) {
        if (methods[m]) n++;
      }
    }
    expect(n).toBe(30);
  });

  test("every operationId is either JSON-mapped or binary (nothing unaccounted)", () => {
    const allOps = new Set<string>();
    for (const [, methods] of Object.entries(doc.paths)) {
      for (const [, op] of Object.entries(methods as Record<string, any>)) {
        if (op && typeof op === "object" && "operationId" in op) {
          allOps.add(op.operationId);
        }
      }
    }
    const accounted = new Set([...JSON_OPERATIONS, ...BINARY_OPERATIONS]);
    expect(allOps.size).toBe(accounted.size);
    for (const id of allOps) expect(accounted.has(id)).toBe(true);
  });

  test("schema registry keys exist in the spec (no dead operationId)", () => {
    const specIds = new Set<string>();
    for (const [, methods] of Object.entries(doc.paths)) {
      for (const [, op] of Object.entries(methods as Record<string, any>)) {
        if (op && typeof op === "object" && "operationId" in op) specIds.add(op.operationId);
      }
    }
    for (const id of JSON_OPERATIONS) expect(specIds.has(id)).toBe(true);
  });

  test("components.schemas exposes the documented core entities", () => {
    const schemas = doc.components.schemas;
    for (const name of [
      "Ori", "ApiKey", "CreateOriRequest", "OriListResponse", "OriInfoResponse",
      "CommandRequest", "CommandResponse", "EventsResponse", "SnapshotSummary",
      "SnapshotDownloadResponse", "ErrorEnvelope", "LimitsFields", "PromptRun",
    ]) {
      expect(schemas[name]).toBeDefined();
    }
  });
});