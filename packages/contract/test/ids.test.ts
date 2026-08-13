import { describe, expect, test } from "bun:test";
import {
  ORI_ALPHABET,
  oriId,
  apiKeyId,
  apiKeySecret,
  snapshotId,
  requestId,
  oriIdRegex,
  apiKeyIdRegex,
  apiKeySecretRegex,
  requestIdRegex,
  uuidRegex,
  isOriId,
  isApiKeyId,
  isApiKeySecret,
  isSnapshotId,
  isRequestId,
} from "../src/ids";

describe("oriId", () => {
  test("matches the pinned regex", () => {
    for (let i = 0; i < 200; i++) {
      expect(oriIdRegex.test(oriId())).toBe(true);
    }
  });

  test("prefix is exactly or_", () => {
    for (let i = 0; i < 50; i++) {
      expect(oriId().startsWith("or_")).toBe(true);
    }
  });

  test("suffix length is exactly 8 chars", () => {
    for (let i = 0; i < 50; i++) {
      expect(oriId().slice(3)).toHaveLength(8);
    }
  });

  test("suffix uses only the Crockford-ish alphabet (no 0 1 i l o)", () => {
    for (let i = 0; i < 200; i++) {
      const suffix = oriId().slice(3);
      for (const ch of suffix) {
        expect(ORI_ALPHABET).toContain(ch);
      }
    }
  });

  test("alphabet excludes the Crockford-unfriendly characters", () => {
    for (const ch of "01iloIOL") {
      expect(ORI_ALPHABET).not.toContain(ch);
    }
  });

  test("generates high-cardinality diversity", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(oriId());
    expect(seen.size).toBe(500);
  });
});

describe("apiKeyId", () => {
  test("matches sak_ + 24 hex", () => {
    for (let i = 0; i < 100; i++) {
      expect(apiKeyIdRegex.test(apiKeyId())).toBe(true);
    }
  });
  test("hex-only suffix", () => {
    const suffix = apiKeyId().slice(4);
    expect(suffix).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("apiKeySecret", () => {
  test("matches ori_live_ + 40 base62", () => {
    for (let i = 0; i < 100; i++) {
      expect(apiKeySecretRegex.test(apiKeySecret())).toBe(true);
    }
  });
  test("suffix length 40 and alphanumeric-only", () => {
    for (let i = 0; i < 100; i++) {
      const suffix = apiKeySecret().slice(9);
      expect(suffix).toHaveLength(40);
      expect(suffix).toMatch(/^[0-9A-Za-z]{40}$/);
    }
  });
});

describe("snapshotId", () => {
  test("is a uuid v4", () => {
    for (let i = 0; i < 200; i++) {
      const id = snapshotId();
      expect(uuidRegex.test(id)).toBe(true);
      // version nibble = 4, variant nibble in [89ab]
      expect(id[14]).toBe("4");
      expect("89ab").toContain(id[19]);
    }
  });
  test("unique across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(snapshotId());
    expect(seen.size).toBe(1000);
  });
});

describe("requestId", () => {
  test("matches req_ + 26 base32", () => {
    for (let i = 0; i < 100; i++) {
      expect(requestIdRegex.test(requestId())).toBe(true);
    }
  });
  test("suffix length 26", () => {
    expect(requestId().slice(4)).toHaveLength(26);
  });
});

describe("predicates", () => {
  test("isOriId accepts valid and rejects invalid", () => {
    expect(isOriId("or_23456789")).toBe(true);
    expect(isOriId("or_")).toBe(false);
    expect(isOriId("or_234567890")).toBe(false);
    expect(isOriId(null)).toBe(false);
    expect(isOriId(123)).toBe(false);
    expect(isOriId("or_0123abcd")).toBe(false); // contains 0/1
  });

  test("predicates reject non-strings", () => {
    expect(isApiKeyId(undefined)).toBe(false);
    expect(isApiKeySecret({})).toBe(false);
    expect(isSnapshotId(["x"])).toBe(false);
    expect(isRequestId(123)).toBe(false);
  });

  test("regexes anchor ends", () => {
    expect(oriIdRegex.test("xxor_23456789")).toBe(false);
    expect(oriIdRegex.test("or_23456789xx")).toBe(false);
  });
});