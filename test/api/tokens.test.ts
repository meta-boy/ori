import { describe, expect, test } from "bun:test";
import {
  AGENT_TOKEN_REGEX,
  MACHINE_TOKEN_REGEX,
  TOKEN_HEX_LEN,
  TOKEN_KEY_ID,
  TokenStore,
  agentToken,
  machineToken,
} from "@ori/api/tokens";
import { oriId } from "@ori/contract";

// A generator and its validator living apart is how /internal/oris/:id/* came to reject
// every token the system issues: machineAuth.ts carried its own regex for 64 hex chars
// while machineToken() produces 32. These tests check the real generator against the
// exported regex, not a hand-written sample.
process.env.ORI_SNAPSHOT_SECRET ??= "tokens-test-secret";

const ids = Array.from({ length: 200 }, () => oriId());

describe("token format: generators satisfy their own validators", () => {
  test("machineToken always matches MACHINE_TOKEN_REGEX", () => {
    for (const id of ids) expect(machineToken(id)).toMatch(MACHINE_TOKEN_REGEX);
  });

  test("agentToken always matches AGENT_TOKEN_REGEX", () => {
    for (const id of ids) expect(agentToken(id)).toMatch(AGENT_TOKEN_REGEX);
  });

  test("the regexes are built from the same length the generators use", () => {
    const id = oriId();
    expect(machineToken(id)).toHaveLength("ori_mt_".length + TOKEN_HEX_LEN);
    expect(agentToken(id)).toHaveLength("ori_at_".length + TOKEN_HEX_LEN);
  });

  test("the two token kinds are not interchangeable", () => {
    const id = oriId();
    expect(machineToken(id)).not.toMatch(AGENT_TOKEN_REGEX);
    expect(agentToken(id)).not.toMatch(MACHINE_TOKEN_REGEX);
  });

  test("a ori's machine and agent tokens are different values", () => {
    // Both derive from one secret and one ori id; only the `kind` in the signed input
    // separates them. If that were dropped they would be identical and the agent
    // credential would also authorise /internal/oris/:id/*.
    for (const id of ids.slice(0, 50)) {
      expect(machineToken(id)).not.toBe(agentToken(id).replace("ori_at_", "ori_mt_"));
    }
  });
});

describe("tokens are derived, which is what survives a restart", () => {
  test("the same ori id always yields the same token", () => {
    // THE property. Tokens used to live in an in-memory Map, so a control-plane restart
    // orphaned every running ori: the container kept running while exec returned
    // gateway_error and stop could not reach the guest to take a final snapshot.
    const id = oriId();
    expect(machineToken(id)).toBe(machineToken(id));
    expect(agentToken(id)).toBe(agentToken(id));
  });

  test("a fresh TokenStore — a restarted process — still resolves an existing ori", () => {
    const id = oriId();
    const before = new TokenStore();
    before.set(id, { machineToken: machineToken(id), agentToken: agentToken(id) });
    const expected = before.get(id);

    // Nothing carried over: a brand new store, as after a restart.
    const after = new TokenStore();
    expect(after.get(id)).toEqual(expected);
  });

  test("get never returns undefined, for any ori id", () => {
    // Callers used to have to handle a miss, and a miss meant an unreachable ori.
    const store = new TokenStore();
    for (const id of ids.slice(0, 20)) {
      expect(store.get(id).agentToken).toMatch(AGENT_TOKEN_REGEX);
    }
  });

  test("delete does not make a ori unreachable", () => {
    // stop() calls delete when a ori is destroyed. If that actually dropped state, a resume
    // of the same ori id would mint tokens the ori does not have.
    const id = oriId();
    const store = new TokenStore();
    const before = store.get(id);
    store.delete(id);
    expect(store.get(id)).toEqual(before);
  });
});

describe("tokens are separated per ori and per key", () => {
  test("different oris get different tokens", () => {
    const seen = new Set(ids.map((id) => machineToken(id)));
    expect(seen.size).toBe(ids.length);
  });

  test("a ori cannot derive another ori's token without the secret", () => {
    // The security property behind the §5 invariant: the ori id is public, so knowing it must
    // not be enough. Only the secret closes the gap, and oris do not hold it.
    const a = oriId();
    const b = oriId();
    expect(machineToken(a)).not.toBe(machineToken(b));
    expect(agentToken(a)).not.toBe(agentToken(b));
  });

  test("the derivation carries a key id, so it can be rotated later", () => {
    // Snapshot repo passwords have no key id and are therefore unrotatable
    // (docs/OPEN-DECISIONS.md #1). Tokens must not repeat that mistake.
    expect(TOKEN_KEY_ID).toBeTruthy();
  });

  test("changing the secret changes every token", () => {
    const id = oriId();
    const original = process.env.ORI_SNAPSHOT_SECRET;
    const first = machineToken(id);
    process.env.ORI_SNAPSHOT_SECRET = `${original}-rotated`;
    try {
      expect(machineToken(id)).not.toBe(first);
    } finally {
      process.env.ORI_SNAPSHOT_SECRET = original;
    }
    // And back again, to prove it is the secret doing the work and nothing is memoised.
    expect(machineToken(id)).toBe(first);
  });

  test("no secret is a hard failure, never a default", () => {
    // A fallback secret would make every deployment that forgot to set it share one set of
    // per-ori credentials, and it would fail silently. See docs/OPERATIONS.md.
    const original = process.env.ORI_SNAPSHOT_SECRET;
    delete process.env.ORI_SNAPSHOT_SECRET;
    try {
      expect(() => machineToken(oriId())).toThrow(/ORI_SNAPSHOT_SECRET/);
    } finally {
      process.env.ORI_SNAPSHOT_SECRET = original;
    }
  });
});
