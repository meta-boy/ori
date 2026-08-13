import { describe, expect, test } from "bun:test";
import {
  UpdateOriRequestSchema,
  PromptRunResponseSchema,
  FileReadResponseSchema,
  FileWriteResponseSchema,
  CommandResponseSchema,
  SnapshotListResponseSchema,
  OriInfoResponseSchema,
  OriListResponseSchema,
  CreateOriResponseSchema,
  OriActionResponseSchema,
  EventsResponseSchema,
  SnapshotDownloadResponseSchema,
} from "../src/schemas";

function valid(schema: any, value: unknown): boolean {
  return (schema.safeParse(value) as { success: boolean }).success;
}

const ori = {
  id: "or_23456789",
  name: "Ori",
  state: "idle",
  desktopAvailable: true,
  snapshotAvailable: false,
};
const pageInto = {
  nextCursor: null,
  hasMore: false,
  limit: 50,
};

describe("response schemas without prose examples (validated directly here)", () => {
  test("update response is ori.info", () => {
    expect(valid(OriInfoResponseSchema, { ok: true, type: "ori.info", ori })).toBe(true);
  });

  test("update request rejects over-long name", () => {
    expect(valid(UpdateOriRequestSchema, { name: "y".repeat(120) })).toBe(true);
    expect(valid(UpdateOriRequestSchema, { name: "y".repeat(121) })).toBe(false);
  });

  test("promptRunStatus response is prompt.run", () => {
    expect(
      valid(PromptRunResponseSchema, {
        ok: true,
        type: "prompt.run",
        id: "or_23456789",
        promptRun: {
          id: "p1",
          promptId: "p1",
          oriId: "or_23456789",
          status: "finished",
          done: true,
          model: "gpt-5.4",
          reasoningEffort: null,
        },
      }),
    ).toBe(true);
    expect(valid(PromptRunResponseSchema, { ok: true, type: "prompt.run", id: "or_23456789", promptRun: { id: "p", promptId: "p", oriId: "or_23456789", status: "bogus", done: true } })).toBe(false);
  });

  test("read/write file responses pin their type consts", () => {
    const read = { ok: true, type: "file.read", success: true, path: "a", encoding: "utf8", size: 1, content: "x" };
    const write = { ok: true, type: "file.written", success: true, path: "a", encoding: "utf8", size: 1 };
    expect(valid(FileReadResponseSchema, read)).toBe(true);
    expect(valid(FileWriteResponseSchema, write)).toBe(true);
    expect(valid(FileWriteResponseSchema, write)).toBe(true);
  });

  test("command response requires session frame", () => {
    expect(
      valid(CommandResponseSchema, {
        ok: true,
        type: "command.finished",
        success: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    ).toBe(true);
  });

  test("listOriSnapshots shares snapshot.list shape", () => {
    expect(
      valid(SnapshotListResponseSchema, {
        ok: true,
        type: "snapshot.list",
        snapshots: [],
        pageInfo: pageInto,
      }),
    ).toBe(true);
  });
});

describe("pinned type discriminators (envelope contract)", () => {
  test("create response is exactly ori.created / status provisioning", () => {
    expect(
      valid(CreateOriResponseSchema, {
        ok: true,
        type: "ori.created",
        status: "provisioning",
        ttlSeconds: 3600,
        ori,
      }),
    ).toBe(true);
    expect(valid(CreateOriResponseSchema, { ok: true, type: "ori.created", status: "ready", ttlSeconds: 3600, ori })).toBe(false);
  });

  test("ori actions accept the documented type/status words", () => {
    for (const t of ["ori.stopping", "ori.resuming", "ori.forking", "ori.interrupted"]) {
      expect(valid(OriActionResponseSchema, { ok: true, type: t, id: "or_23456789", status: "archiving" })).toBe(true);
    }
  });

  test("ori list and events pages", () => {
    expect(valid(OriListResponseSchema, { ok: true, type: "ori.list", oris: [ori], pageInfo: pageInto })).toBe(true);
    expect(
      valid(EventsResponseSchema, {
        ok: true,
        type: "events.list",
        id: "or_23456789",
        events: [{ type: "prompt", timestamp: 1, data: { prompt: "x", status: "queued" } }],
        pageInfo: pageInto,
      }),
    ).toBe(true);
  });
});

describe("snapshot download reassembly contract", () => {
  const chunk = (gen: number, idx: number) => ({
    snapshotId: "2db50582-716c-424c-817e-9495484f88dd",
    generation: gen,
    chunkIndex: idx,
    r2Key: `chains/x/snapshots/s/chunks/${String(idx).padStart(2, "0")}`,
    sizeBytes: 1,
    sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    signedUrl: "https://r2.example/c",
  });

  test("accepts a valid download payload", () => {
    expect(
      valid(SnapshotDownloadResponseSchema, {
        ok: true,
        type: "snapshot.download",
        snapshotId: "2db50582-716c-424c-817e-9495484f88dd",
        oriId: "or_23456789",
        kind: "incremental",
        generation: 2,
        expiresInSeconds: 3600,
        reconstruct: "concat by generation/index",
        inventory: { r2Key: "chains/x/inv", signedUrl: "https://r2.example/i" },
        chunks: [chunk(0, 0), chunk(0, 1), chunk(1, 0), chunk(2, 0)],
      }),
    ).toBe(true);
  });

  test("kind limited to base/incremental/legacy", () => {
    expect(
      valid(SnapshotDownloadResponseSchema, {
        ok: true,
        type: "snapshot.download",
        snapshotId: "2db50582-716c-424c-817e-9495484f88dd",
        oriId: "or_23456789",
        kind: "full",
        generation: 0,
        expiresInSeconds: 1,
        reconstruct: "x",
        chunks: [chunk(0, 0)],
      }),
    ).toBe(false);
  });
});