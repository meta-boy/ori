import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { z } from "zod";
import {
  OriActionResponseSchema,
  OriInfoResponseSchema,
  OriListResponseSchema,
  CommandResponseSchema,
  CreateOriResponseSchema,
  DesktopResponseSchema,
  EventsResponseSchema,
  FileReadResponseSchema,
  FileWriteResponseSchema,
  LimitsResponseSchema,
  MeResponseSchema,
  PromptResponseSchema,
  PromptRunResponseSchema,
  RepoSelectionResponseSchema,
  ReposResponseSchema,
  SecretsResponseSchema,
  SshKeyResponseSchema,
  SnapshotDownloadResponseSchema,
  SnapshotLatestResponseSchema,
  SnapshotListResponseSchema,
  SnapshotTreeResponseSchema,
  ApiKeysResponseSchema,
  ErrorEnvelopeSchema,
} from "@ori/contract";

const SPEC_PATH = fileURLToPath(
  new URL("../../openapi/ori-v1.yaml", import.meta.url),
);

export interface OpenApiDocument {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
}

export function loadOpenApi(): OpenApiDocument {
  return yaml.load(readFileSync(SPEC_PATH, "utf8")) as OpenApiDocument;
}

/**
 * operationId -> the transaction's primary 2xx JSON response schema.
 * Binary (octet-stream) endpoints are intentionally omitted.
 */
const RESPONSE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  me: MeResponseSchema,
  limits: LimitsResponseSchema,
  repos: ReposResponseSchema,
  selectRepo: RepoSelectionResponseSchema,
  apiKeys: ApiKeysResponseSchema,
  secrets: SecretsResponseSchema,
  updateSecrets: SecretsResponseSchema,
  oris: OriListResponseSchema,
  create: CreateOriResponseSchema,
  get: OriInfoResponseSchema,
  update: OriInfoResponseSchema,
  stop: OriActionResponseSchema,
  resume: OriActionResponseSchema,
  fork: OriActionResponseSchema,
  prompt: PromptResponseSchema,
  events: EventsResponseSchema,
  promptRunStatus: PromptRunResponseSchema,
  readFile: FileReadResponseSchema,
  writeFile: FileWriteResponseSchema,
  command: CommandResponseSchema,
  interrupt: OriActionResponseSchema,
  desktop: DesktopResponseSchema,
  sshKey: SshKeyResponseSchema,
  listSnapshots: SnapshotListResponseSchema,
  listOriSnapshots: SnapshotListResponseSchema,
  getLatestOriSnapshot: SnapshotLatestResponseSchema,
  getSnapshotTree: SnapshotTreeResponseSchema,
  getSnapshotDownload: SnapshotDownloadResponseSchema,
};

/**
 * The single check that keeps API compatibility real: every route's response
 * must validate against the OpenAPI-powered zod schema.
 */
export function assertValidResponse(operationId: string, body: unknown): void {
  const schema = RESPONSE_SCHEMAS[operationId];
  if (!schema) {
    throw new Error(`no contract schema registered for operationId "${operationId}"`);
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(
      `contract violation for "${operationId}": ${z.prettifyError(result.error)}`,
    );
  }
}

export function assertErrorEnvelope(body: unknown): void {
  const result = ErrorEnvelopeSchema.safeParse(body);
  if (!result.success) {
    throw new Error(`error envelope violation: ${z.prettifyError(result.error)}`);
  }
}

/** Collect `(operationId, exampleValue)` pairs for every JSON example in the spec. */
export function collectJsonExamples(doc: OpenApiDocument): {
  operationId: string;
  value: unknown;
  label: string;
}[] {
  const out: { operationId: string; value: unknown; label: string }[] = [];
  for (const [, methods] of Object.entries(doc.paths)) {
    for (const [, operation] of Object.entries(methods as any)) {
      if (!operation || typeof operation !== "object" || !("operationId" in operation)) continue;
      const op = operation as { operationId: string; responses: Record<string, any> };
      const statuses = ["200", "201", "202"];
      for (const st of statuses) {
        const resp = op.responses?.[st];
        const content = resp?.content?.["application/json"] ?? resp?.content?.["application/json; charset=utf-8"];
        const examples = content?.examples;
        if (!examples) continue;
        for (const [label, ex] of Object.entries(examples as Record<string, any>)) {
          if (ex && ex.value !== undefined) {
            if (op.operationId in RESPONSE_SCHEMAS) {
              out.push({ operationId: op.operationId, value: ex.value, label });
            }
          }
        }
      }
    }
  }
  return out;
}