import { describe, expect, test } from "bun:test";
import {
  OriSchema,
  CreateOriRequestSchema,
  ResumeRequestSchema,
  UpdateOriRequestSchema,
  PromptRequestSchema,
  CommandRequestSchema,
  CommandResponseSchema,
  FileWriteRequestSchema,
  FileReadResponseSchema,
  SnapshotSummarySchema,
  SnapshotChunkSchema,
  TtlSecondsSchema,
  LimitQuerySchema,
  OriIdSchema,
} from "../src/schemas";

function valid(schema: any, value: unknown): boolean {
  const r = schema.safeParse(value) as { success: boolean };
  return r.success;
}
function invalid(schema: any, value: unknown): boolean {
  const r = schema.safeParse(value) as { success: boolean };
  return !r.success;
}

describe("CreateOriRequest", () => {
  const base = {};

  test("defaults type to 'default' and ttlSeconds to 3600", () => {
    const parsed = CreateOriRequestSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("default");
      expect(parsed.data.ttlSeconds).toBe(3600);
      expect(parsed.data.noEnv).toBe(false);
    }
  });

  test("accepts small/large types and null ttl", () => {
    expect(valid(CreateOriRequestSchema, { type: "small", ttlSeconds: null })).toBe(true);
    expect(valid(CreateOriRequestSchema, { type: "large" })).toBe(true);
  });

  test("rejects bare-metal (not requestable) and unknown types", () => {
    expect(invalid(CreateOriRequestSchema, { type: "bare-metal" })).toBe(true);
    expect(invalid(CreateOriRequestSchema, { type: "huge" })).toBe(true);
  });

  test("binds ttlSeconds to 1..2592000", () => {
    expect(valid(CreateOriRequestSchema, { ttlSeconds: 1 })).toBe(true);
    expect(valid(CreateOriRequestSchema, { ttlSeconds: 2592000 })).toBe(true);
    expect(invalid(CreateOriRequestSchema, { ttlSeconds: 0 })).toBe(true);
    expect(invalid(CreateOriRequestSchema, { ttlSeconds: 2592001 })).toBe(true);
  });
});

describe("ResumeRequest / UpdateOriRequest", () => {
  test("resume type must be requestable", () => {
    expect(valid(ResumeRequestSchema, { type: "large" })).toBe(true);
    expect(invalid(ResumeRequestSchema, { type: "bare-metal" })).toBe(true);
  });

  test("update name length 1..120 and valid subdomain regex", () => {
    expect(valid(UpdateOriRequestSchema, { name: "x" })).toBe(true);
    expect(invalid(UpdateOriRequestSchema, { name: "" })).toBe(true);
    expect(valid(UpdateOriRequestSchema, { subdomain: "acme-2" })).toBe(true);
    expect(invalid(UpdateOriRequestSchema, { subdomain: "-bad" })).toBe(true);
  });
});

describe("PromptRequest", () => {
  test("requires provider and non-empty prompt", () => {
    expect(valid(PromptRequestSchema, { provider: "codex", prompt: "do it" })).toBe(true);
    expect(invalid(PromptRequestSchema, { provider: "codex" })).toBe(true);
    expect(invalid(PromptRequestSchema, { prompt: "do it" })).toBe(true);
    expect(invalid(PromptRequestSchema, { provider: "codex", prompt: "" })).toBe(true);
  });

  test("accepts documented providers incl. claude alias", () => {
    expect(valid(PromptRequestSchema, { provider: "claude-code", prompt: "x" })).toBe(true);
    expect(valid(PromptRequestSchema, { provider: "claude", prompt: "x" })).toBe(true);
    expect(invalid(PromptRequestSchema, { provider: "gemini", prompt: "x" })).toBe(true);
  });
});

describe("CommandRequest / CommandResponse", () => {
  test("command required; timeoutSeconds capped at 60", () => {
    expect(valid(CommandRequestSchema, { command: "ls" })).toBe(true);
    expect(invalid(CommandRequestSchema, {})).toBe(true);
    expect(valid(CommandRequestSchema, { command: "x", timeoutSeconds: 60 })).toBe(true);
    expect(invalid(CommandRequestSchema, { command: "x", timeoutSeconds: 61 })).toBe(true);
    expect(invalid(CommandRequestSchema, { command: "x", timeoutSeconds: 0 })).toBe(true);
  });

  test("command.response requires the documented frame", () => {
    expect(
      valid(CommandResponseSchema, {
        ok: true,
        type: "command.finished",
        success: true,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        cwd: "/home/user",
        startedAt: "2026-05-31T12:00:00Z",
        finishedAt: "2026-05-31T12:00:01Z",
      }),
    ).toBe(true);
    expect(invalid(CommandResponseSchema, { ok: true, type: "command.finished" })).toBe(true);
    expect(invalid(CommandResponseSchema, { ok: true, type: "wrong", success: true, exitCode: 0, stdout: "", stderr: "", timedOut: false })).toBe(true);
  });
});

describe("files", () => {
  test("file write request accepts utf8 default and base64", () => {
    expect(valid(FileWriteRequestSchema, { path: "a.txt", content: "hi" })).toBe(true);
    const p = FileWriteRequestSchema.safeParse({ path: "a.txt", content: "aGk=", encoding: "base64" });
    expect(p.success).toBe(true);
  });

  test("file read response pins type file.read", () => {
    expect(
      valid(FileReadResponseSchema, {
        ok: true,
        type: "file.read",
        success: true,
        path: "a.txt",
        encoding: "utf8",
        size: 2,
        content: "hi",
      }),
    ).toBe(true);
    expect(invalid(FileReadResponseSchema, { ok: true, type: "file.written", success: true, path: "a", encoding: "utf8", size: 1, content: "x" })).toBe(true);
  });
});

describe("snapshots", () => {
  const snap = {
    id: "7417be09-d419-4ae0-b3fc-7f04a5a71ef1",
    oriId: "or_23456789",
    status: "completed",
    kind: "incremental",
    generation: 3,
    chainId: "4ced5b04-d2cb-4ec3-b127-3b3ed836cab5",
    createdAt: "2026-06-24T06:24:00Z",
    sizeBytes: 18874368,
    fileCount: 6781,
  };
  test("valid snapshot summary", () => {
    expect(valid(SnapshotSummarySchema, snap)).toBe(true);
  });
  test("status must be completed and generation an int", () => {
    expect(invalid(SnapshotSummarySchema, { ...snap, status: "queued" })).toBe(true);
    expect(invalid(SnapshotSummarySchema, { ...snap, generation: 3.5 })).toBe(true);
  });
  test("sha256 must be 64 hex", () => {
    expect(
      valid(SnapshotChunkSchema, {
        snapshotId: "2db50582-716c-424c-817e-9495484f88dd",
        generation: 0,
        chunkIndex: 0,
        r2Key: "chains/x/chunks/00",
        sizeBytes: 1,
        sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        signedUrl: "https://r2.example/chunk",
      }),
    ).toBe(true);
    expect(
      invalid(SnapshotChunkSchema, {
        ...{ snapshotId: "2db50582-716c-424c-817e-9495484f88dd", generation: 0, chunkIndex: 0, r2Key: "k", sizeBytes: 1, signedUrl: "https://x" },
        sha256: "zz",
      }),
    ).toBe(true);
  });
});

describe("Ori", () => {
  test("requires the four documented required fields", () => {
    const b = {
      id: "or_23456789",
      name: "Ori",
      state: "idle",
      desktopAvailable: true,
      snapshotAvailable: false,
    };
    expect(valid(OriSchema, b)).toBe(true);
    expect(invalid(OriSchema, { ...b, id: undefined })).toBe(true);
    expect(invalid(OriSchema, { ...b, state: undefined })).toBe(true);
    expect(invalid(OriSchema, { ...b, desktopAvailable: undefined })).toBe(true);
    expect(invalid(OriSchema, { ...b, snapshotAvailable: undefined })).toBe(true);
  });

  test("rejects an unknown state and invalid ori id", () => {
    const b = {
      id: "or_23456789",
      name: "Ori",
      state: "idle",
      desktopAvailable: true,
      snapshotAvailable: false,
    };
    expect(invalid(OriSchema, { ...b, state: "sleeping" })).toBe(true);
    expect(invalid(OriSchema, { ...b, id: "or_01234567" })).toBe(true);
  });

  test("tolerates null optional fields", () => {
    expect(
      valid(OriSchema, {
        id: "or_23456789",
        name: "Ori",
        state: "ready",
        desktopAvailable: true,
        snapshotAvailable: true,
        url: null,
        ip: null,
        createdAt: "2026-05-31T12:00:00Z",
        updatedAt: "2026-05-31T12:05:00Z",
        archiveAfter: "2026-05-31T13:00:00Z",
        desktopUrl: null,
        snapshotCompletedAt: null,
        subdomain: "frazil-pneuma-rallye",
      }),
    ).toBe(true);
  });
});

describe("primitives", () => {
  test("TtlSeconds allows int 1..2592000 and null", () => {
    expect(valid(TtlSecondsSchema, 3600)).toBe(true);
    expect(valid(TtlSecondsSchema, null)).toBe(true);
    expect(invalid(TtlSecondsSchema, 0)).toBe(true);
    expect(invalid(TtlSecondsSchema, 2592001)).toBe(true);
    expect(invalid(TtlSecondsSchema, "infinite")).toBe(true);
  });

  test("limit query bounded 1..200 default 100", () => {
    expect(LimitQuerySchema.safeParse("50").data).toBe(50);
    expect(LimitQuerySchema.safeParse(undefined).data).toBe(100);
    expect(valid(LimitQuerySchema, 200)).toBe(true);
    expect(invalid(LimitQuerySchema, 201)).toBe(true);
    expect(invalid(LimitQuerySchema, 0)).toBe(true);
  });

  test("ori id regex", () => {
    expect(valid(OriIdSchema, "or_23456789")).toBe(true);
    expect(invalid(OriIdSchema, "or_12345678")).toBe(true);
    expect(invalid(OriIdSchema, "or_2345678")).toBe(true);
  });
});