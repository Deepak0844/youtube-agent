import { describe, expect, it } from "vitest";
import { estimateVideosLeft, usageLine } from "@/server/engine/usage";

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
