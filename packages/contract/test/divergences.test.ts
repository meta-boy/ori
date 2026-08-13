import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ERROR_CODES } from "../src/errors";

// The whole point of this project is that a client generated against ori's published
// OpenAPI works unmodified against our server. An error code we invent silently breaks
// that: the response is a perfectly well-shaped envelope, so the contract harness passes
// it, and only a real client switching on `code` ever notices.
//
// That already happened once. `invalid_body` was returned by POST /oris and POST /fork --
// two of the hottest paths -- while the spec uses `invalid_json` for a body that fails
// validation. 300+ green tests and the OpenAPI conformance harness all missed it, because
// every test asserted what the code did.
//
// So: every ErrorCode must be justified by either the spec or an explicit entry in
// docs/DIVERGENCES.md. Adding a code with no home fails the build.
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const spec = readFileSync(`${repoRoot}/openapi/ori-v1.yaml`, "utf8");
const divergences = readFileSync(`${repoRoot}/docs/DIVERGENCES.md`, "utf8");

// Ori publishes error codes in TWO places and neither is a superset of the other:
//   1. openapi/ori-v1.yaml, which only names the codes its own examples happen to use.
//   2. the published status/code table, which lists these but which the spec
//      never references. Verified: all six were flagged as "invented" by the first run
//      of this test purely because they are absent from the YAML.
// A code justified by either is not a divergence.
const DOCUMENTED_BY_DOCS_TABLE = [
  "invalid_json",
  "prompt_required",
  "invalid_name",
  "machine_not_running",
  "type_too_small",
  "unauthorized",
  "billing_required",
  "not_found",
  "provider_not_configured",
  "ori_not_promptable",
  "resume_failed",
  "ori_restoring",
  "rate_limited",
  "daily_limit_reached",
  "invalid_json_response",
  "stream_failed",
] as const;

/** In the OpenAPI document, or on the published status/code table. */
function inSpec(code: string): boolean {
  return new RegExp(`\\b${code}\\b`).test(spec) || (DOCUMENTED_BY_DOCS_TABLE as readonly string[]).includes(code);
}

/** A code counts as declared if DIVERGENCES.md names it in a table row or prose. */
function declared(code: string): boolean {
  return new RegExp(`\`${code}\``).test(divergences);
}

describe("error codes are justified by the spec or declared as divergences", () => {
  test("no undeclared invented code", () => {
    const undeclared = ERROR_CODES.filter((c) => !inSpec(c) && !declared(c));
    // Named in the failure so the fix is obvious: either it belongs in the spec (you
    // read the spec wrong) or it belongs in DIVERGENCES.md (you invented it on purpose).
    expect(undeclared).toEqual([]);
  });

  test("invalid_body is gone; a body that fails validation is invalid_json", () => {
    expect(ERROR_CODES).not.toContain("invalid_body");
    expect(ERROR_CODES).toContain("invalid_json");
  });

  test("every documented code we claim to support is actually defined", () => {
    // If we drop one of ori's documented codes, a client that branches on it never sees
    // it and silently falls through to generic handling.
    const missing = DOCUMENTED_BY_DOCS_TABLE.filter((c) => !ERROR_CODES.includes(c as (typeof ERROR_CODES)[number]));
    expect(missing).toEqual([]);
  });
});
