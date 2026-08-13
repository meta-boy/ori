import { describe, expect, test } from "bun:test";
import {
  validateEnvObject,
  validateEnvContents,
  parseEnvContents,
  validateSecretFiles,
  validateSecretPath,
  validateSubdomain,
  validateOriName,
  validateWorkPath,
  isValidEnvName,
  RESERVED_ENV_NAMES,
  MAX_ENV_VARS,
  MAX_ENV_BYTES,
} from "../src/validation";

describe("env name rules", () => {
  test("valid names", () => {
    expect(isValidEnvName("A")).toBe(true);
    expect(isValidEnvName("_")).toBe(true);
    expect(isValidEnvName("FOO_BAR123")).toBe(true);
    expect(isValidEnvName("a".repeat(128))).toBe(true); // KEY{0,127} => total up to 128
  });

  test("invalid names", () => {
    expect(isValidEnvName("1FOO")).toBe(false); // cannot start with digit
    expect(isValidEnvName("FOO-BAR")).toBe(false);
    expect(isValidEnvName("FOO.BAR")).toBe(false);
    expect(isValidEnvName("")).toBe(false);
    expect(isValidEnvName("a".repeat(129))).toBe(false); // too long
    expect(isValidEnvName("FOO BAR")).toBe(false);
  });
});

describe("validateEnvObject", () => {
  test("accepts a normal map", () => {
    expect(validateEnvObject({ DATABASE_URL: "postgres://x", FLAG: "1" })).toEqual({ ok: true });
  });

  test("undefined is accepted", () => {
    expect(validateEnvObject(undefined)).toEqual({ ok: true });
  });

  test("rejects reserved names with invalid_env", () => {
    for (const name of RESERVED_ENV_NAMES) {
      const r = validateEnvObject({ [name]: "x" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_env");
    }
  });

  test("rejects invalid name", () => {
    const r = validateEnvObject({ "BAD-NAME": "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_env");
  });

  test("enforces the 100-var cap", () => {
    const env: Record<string, string> = {};
    for (let i = 0; i <= MAX_ENV_VARS; i++) env[`K${i}`] = "1";
    const r = validateEnvObject(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_env");
  });

  test("64KB cap is counted on key+value bytes", () => {
    const ok = validateEnvObject({ A: "x".repeat(100) });
    expect(ok.ok).toBe(true);
    const over: Record<string, string> = {};
    let payload = "";
    while (payload.length < MAX_ENV_BYTES + 1) payload += "x";
    over.A = payload;
    expect(validateEnvObject(over).ok).toBe(false);
  });
});

describe("parseEnvContents + validateEnvContents", () => {
  test("parses KEY=VALUE lines, comments and blanks", () => {
    const map = parseEnvContents("# a\nFOO=bar\n\nBAZ=qux\n");
    expect([...map.entries()]).toEqual([
      ["FOO", "bar"],
      ["BAZ", "qux"],
    ]);
  });

  test("only strips quotes when the whole value is quoted", () => {
    expect(parseEnvContents('A="v"\nB=\'w\'\n').get("A")).toBe("v");
    expect(parseEnvContents('A="v"\nB=\'w\'\n').get("B")).toBe("w");
    // mid-value quotes are kept verbatim
    expect(parseEnvContents('C=qux="1"\n').get("C")).toBe('qux="1"');
  });

  test("validateEnvContents passes good content", () => {
    expect(validateEnvContents("OPENAI_KEY=sk-...\n").ok).toBe(true);
  });

  test("validateEnvContents rejects reserved and names and overflow", () => {
    expect(validateEnvContents("ORI_ID=abc\n").ok).toBe(false);
    expect(validateEnvContents("1BAD=abc\n").ok).toBe(false);
    expect(validateEnvContents("x".repeat(MAX_ENV_BYTES + 1)).ok).toBe(false);
  });
});

describe("secret-file paths (relative, no absolute, no .. escapes)", () => {
  test("valid relative paths", () => {
    expect(validateSecretPath(".config/service.json")).toEqual({ ok: true });
    expect(validateSecretPath("a/b/c")).toEqual({ ok: true });
  });

  test("absolute paths are skipped", () => {
    const r = validateSecretPath("/etc/passwd");
    expect(r.ok).toBe(false);
  });

  test(".. escapes are rejected", () => {
    expect(validateSecretPath("../nope").ok).toBe(false);
    expect(validateSecretPath("a/../../etc").ok).toBe(false);
    expect(validateSecretPath("a/./b").ok).toBe(false);
  });

  test("empty path rejected", () => {
    expect(validateSecretPath("").ok).toBe(false);
  });

  test("validateSecretFiles checks every entry", () => {
    expect(
      validateSecretFiles([
        { path: "ok.json", contents: "{}" },
        { path: "also-ok", contents: "x" },
      ]).ok,
    ).toBe(true);
    expect(
      validateSecretFiles([{ path: "fine", contents: "x" }, { path: "..", contents: "y" }]).ok,
    ).toBe(false);
  });

  test("undefined files list accepted", () => {
    expect(validateSecretFiles(undefined)).toEqual({ ok: true });
  });
});

describe("subdomain validation", () => {
  test("accepts valid slugs", () => {
    expect(validateSubdomain("acme-staging")).toEqual({ ok: true });
    expect(validateSubdomain("a3b")).toEqual({ ok: true });
  });

  test("rejects reserved suffixes", () => {
    expect(validateSubdomain("x-desktop").ok).toBe(false);
    expect(validateSubdomain("x-123").ok).toBe(false);
  });

  test("rejects malformed slugs", () => {
    expect(validateSubdomain("ab").ok).toBe(false); // <3
    expect(validateSubdomain("-lead").ok).toBe(false);
    expect(validateSubdomain("trail-").ok).toBe(false);
    expect(validateSubdomain("UPPER").ok).toBe(false);
    expect(validateSubdomain("a".repeat(41)).ok).toBe(false);
  });

  test("allows internal double hyphens (the contract regex does not forbid them)", () => {
    expect(validateSubdomain("double--hyphen").ok).toBe(true);
  });
});

describe("ori name validation", () => {
  test("empty is rejected", () => {
    expect(validateOriName("").ok).toBe(false);
  });
  test("1..120 allowed", () => {
    expect(validateOriName("x").ok).toBe(true);
    expect(validateOriName("y".repeat(120)).ok).toBe(true);
  });
  test(">120 flagged (backend truncates, does not reject)", () => {
    const r = validateOriName("y".repeat(121));
    expect(r.ok).toBe(false);
  });
});

describe("work path validation (commands cwd / files)", () => {
  test("accepts relative", () => {
    expect(validateWorkPath("src")).toEqual({ ok: true });
    expect(validateWorkPath(undefined)).toEqual({ ok: true });
  });
  test("rejects absolute and escapes", () => {
    expect(validateWorkPath("/etc").ok).toBe(false);
    expect(validateWorkPath("../../x").ok).toBe(false);
    expect(validateWorkPath("./x").ok).toBe(false);
  });
});