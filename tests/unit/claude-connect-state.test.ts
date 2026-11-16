import { describe, expect, it } from "vitest";
import { claudeConnectState } from "@/server/core/ai-source";

describe("claudeConnectState", () => {
  it("never connected, or the last call did not pass: nothing to suggest yet", () => {
    expect(claudeConnectState(null, false)).toBe("not_connected");
    for (const result of ["not_logged_in", "not_found", "failed", "limit_reached"] as const) expect(claudeConnectState({ result }, false), result).toBe("not_connected");
    expect(claudeConnectState({ result: "failed" }, true)).toBe("not_connected");
  });
  it("last call passed but the AI source is still on API keys: suggest turning Claude Code on", () => {
    expect(claudeConnectState({ result: "ready" }, false)).toBe("turn_on");
  });
  it("last call passed and Claude Code is the source: connected and in use", () => {
    expect(claudeConnectState({ result: "ready" }, true)).toBe("on");
  });
});
