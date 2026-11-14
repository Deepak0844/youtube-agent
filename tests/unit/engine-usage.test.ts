import { describe, expect, it } from "vitest";
import { engineRunView, engineTotals, estimateVideosLeft, usageLine } from "@/server/engine/usage";

// Health's "videos left this window" (engine-core spec): Claude does not tell the window's size, so it is learned from the
// last time the limit was hit (tokens used in the 5 hours before it). Until then, or with fewer than 3 videos, no estimate.

describe("estimateVideosLeft", () => {
  it("estimate_is_null_with_fewer_than_3_videos_or_no_limit_seen", () => {
    expect(estimateVideosLeft({ capacityTokens: null, usedTokens: 0, perVideoTokens: [100, 100, 100] })).toBeNull();
    expect(estimateVideosLeft({ capacityTokens: 1000, usedTokens: 0, perVideoTokens: [100, 100] })).toBeNull();
  });
  it("estimate_uses_recent_average", () => {
    expect(estimateVideosLeft({ capacityTokens: 1000, usedTokens: 300, perVideoTokens: [100, 200, 300] })).toBe(3); // (1000-300)/200
    expect(estimateVideosLeft({ capacityTokens: 1000, usedTokens: 1200, perVideoTokens: [100, 200, 300] })).toBe(0);
  });
});

describe("usageLine", () => {
  it("is one plain line with tokens, turns and the API-equivalent cost", () => {
    expect(usageLine({ inputTokens: 12_345, outputTokens: 2_100, costUsdEquiv: 0.4234, turns: 7 })).toBe("Claude: 14.4k tokens, 7 turns, about $0.42 API-equivalent (not billed)");
    expect(usageLine({ inputTokens: 900, outputTokens: 50, costUsdEquiv: 0, turns: 1 })).toBe("Claude: 950 tokens, 1 turn, about $0.00 API-equivalent (not billed)");
  });
});

describe("engineRunView", () => {
  const base = { id: "r1", stage: "tsx_author", status: "succeeded", startedAt: new Date("2026-11-14T10:51:00Z"), endedAt: new Date("2026-11-14T11:09:30Z"), model: "claude-sonnet-5", turns: 53, inputTokens: 82, outputTokens: 61_941, cacheReadTokens: 2_400_000, cacheCreationTokens: 180_000, costUsdEquiv: 3.4721, durationMs: 1_110_000, durationApiMs: 700_000, toolCalls: { check_code: 4, preview_frames: 9, check_frames: 2, other: 30 }, error: null as string | null };

  it("shows_model_tokens_time_tools_and_the_api_equivalent_in_ist_and_rupees", () => {
    const v = engineRunView(base, 95.05);
    expect(v.when).toBe("2026-11-14 16:21 IST"); // 10:51 UTC
    expect(v.duration).toBe("18 min 30 s");
    expect(v.model).toBe("claude-sonnet-5");
    expect(v.tokens).toBe("output 61.9k, input 82, cache read 2.4M, cache written 180.0k");
    expect(v.turns).toBe("53 turns");
    expect(v.apiEquivalent).toBe("$3.47 (₹330.0)");
    expect(v.tools).toBe("preview_frames 9, check_code 4, check_frames 2, other 30");
    expect(v.statusWord).toBe("Succeeded");
  });

  it("says_so_when_figures_are_missing_instead_of_inventing_them", () => {
    const v = engineRunView({ ...base, model: null, cacheReadTokens: null, cacheCreationTokens: null, durationMs: null, toolCalls: {}, costUsdEquiv: null, inputTokens: null, outputTokens: null, turns: null, endedAt: null, status: "running" }, 95.05);
    expect(v.model).toBe("model not reported");
    expect(v.tokens).toBe("tokens not reported");
    expect(v.apiEquivalent).toBe("not reported");
    expect(v.tools).toBe("no tool calls recorded");
    expect(v.duration).toBe("still running");
    expect(v.statusWord).toBe("Running");
  });

  it("a_failed_run_carries_its_plain_reason", () => {
    expect(engineRunView({ ...base, status: "failed", error: "Claude used all its turns without finishing." }, null).note).toBe("Claude used all its turns without finishing.");
    expect(engineRunView({ ...base, status: "limit", error: null }, null).statusWord).toBe("Paused by the Claude usage limit");
  });
});

describe("engineTotals", () => {
  it("adds_up_the_runs_of_a_video", () => {
    const run = (o: object) => ({ id: "x", stage: "tsx_author", status: "succeeded", startedAt: new Date(0), endedAt: new Date(1000), model: "claude-sonnet-5", turns: 10, inputTokens: 100, outputTokens: 1000, cacheReadTokens: 5000, cacheCreationTokens: 500, costUsdEquiv: 1.5, durationMs: 60_000, durationApiMs: 1, toolCalls: {}, error: null, ...o });
    const t = engineTotals([run({}), run({ turns: 20, outputTokens: 2000, costUsdEquiv: 2, durationMs: 120_000 }), run({ model: null, cacheReadTokens: null, costUsdEquiv: null, durationMs: null })], null);
    expect(t).toMatchObject({ runs: 3, turns: 40, tokens: "output 4.0k, input 300, cache read 10.0k, cache written 1.5k", apiEquivalent: "$3.50", duration: "3 min 0 s", models: ["claude-sonnet-5"] });
  });
});
