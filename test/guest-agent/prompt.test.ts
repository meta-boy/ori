import { describe, expect, test } from "bun:test";
import {
  PromptRegistry,
  PromptSession,
  providerCommand,
  runPromptSession,
} from "@ori/guest-agent/prompt";

describe("T-P12-04 guest prompt harness", () => {
  test("providerCommand maps codex and claude-code with model/reasoning flags", () => {
    expect(
      providerCommand({ oriId: "or_12345678", promptId: "p1", provider: "codex", model: "gpt-5.4", reasoningEffort: "medium", prompt: "run tests" }),
    ).toEqual(["codex", "exec", "--model", "gpt-5.4", "--reasoning-effort", "medium", "run tests"]);
    expect(
      providerCommand({ oriId: "or_12345678", promptId: "p1", provider: "claude-code", model: "opus", reasoningEffort: null, prompt: "hi" }),
    ).toEqual(["claude", "-p", "--output-format", "text", "--model", "opus", "hi"]);
    // claude is an alias for claude-code
    expect(
      providerCommand({ oriId: "or_12345678", promptId: "p1", provider: "claude", prompt: "hi" })[0],
    ).toBe("claude");
  });

  test("runPromptSession captures stdout lines and finishes with exit code", async () => {
    const session = new PromptSession("p1", "codex");
    await runPromptSession(session, ["bash", "-lc", "echo line-one; echo line-two; exit 0"], "/tmp");
    expect(session.done).toBe(true);
    expect(session.status).toBe("finished");
    expect(session.exitCode).toBe(0);
    const lines = session.lines.map((l) => l.text);
    expect(lines).toEqual(["line-one", "line-two"]);
    expect(session.lines.every((l) => l.stream === "stdout")).toBe(true);
    expect(session.state().lineCount).toBe(2);
  });

  test("a failing command marks the session failed", async () => {
    const session = new PromptSession("p2", "codex");
    await runPromptSession(session, ["bash", "-lc", "echo oops >&2; exit 3"], "/tmp");
    expect(session.done).toBe(true);
    expect(session.status).toBe("failed");
    expect(session.exitCode).toBe(3);
    expect(session.lines[0].stream).toBe("stderr");
    expect(session.lines[0].text).toBe("oops");
  });

  test("kill() interrupts a running session and it becomes done", async () => {
    const session = new PromptSession("p3", "codex");
    const running = runPromptSession(session, ["bash", "-lc", "sleep 30"], "/tmp");
    // Wait until the process is attached and running.
    await new Promise((r) => setTimeout(r, 300));
    expect(session.status).toBe("running");
    session.kill("SIGTERM");
    await running;
    expect(session.done).toBe(true);
    expect(session.status).toBe("failed"); // killed => non-zero exit
    expect(session.exitCode).not.toBe(0);
  });

  test("registry allows one active prompt and prunes done sessions", () => {
    const reg = new PromptRegistry();
    const a = new PromptSession("a", "codex");
    const b = new PromptSession("b", "codex");
    reg.add(a);
    reg.add(b);
    expect(reg.active).toBe(a);
    a.finish(0);
    expect(reg.active).toBe(b);
    b.finish(0);
    expect(reg.active).toBeUndefined();
    // prune keeps the newest N done sessions
    for (let i = 0; i < 15; i++) {
      const s = new PromptSession(`s${i}`, "codex");
      s.finish(0);
      reg.add(s);
    }
    reg.prune(10);
    let count = 0;
    for (const s of (reg as unknown as { sessions: Map<string, PromptSession> }).sessions.values()) {
      if (s.done) count++;
    }
    expect(count).toBe(10);
  });
});
