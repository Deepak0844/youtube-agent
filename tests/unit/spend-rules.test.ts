import { describe, expect, it } from "vitest";
import { UnpricedCallError, callKey, worstCaseMicroUsd, type PriceCard } from "@/server/core/spend";

const card: PriceCard = {
  inputPerMTokMicro: 3_000_000, // $3 / MTok
  outputPerMTokMicro: 15_000_000,
  cacheWritePerMTokMicro: 3_750_000,
  cacheReadPerMTokMicro: 300_000,
  reasoningPerMTokMicro: 15_000_000,
  perCallMicro: 1_000,
  perImageMicro: 40_000,
  perVideoSecondMicro: 500_000,
};

describe("worstCaseMicroUsd", () => {
  it("worst_case_includes_cache_write_reasoning_and_per_call", () => {
    const usage = {
      inputTokens: 1_000_000, // 3_000_000
      maxOutputTokens: 100_000, // 1_500_000
      cacheWriteTokens: 200_000, // 750_000
      cacheReadTokens: 1_000_000, // 300_000
      reasoningTokens: 10_000, // 150_000
      calls: 2, // 2_000
      images: 3, // 120_000
      videoSeconds: 4, // 2_000_000
    };
    expect(worstCaseMicroUsd(card, usage)).toBe(
      3_000_000 + 1_500_000 + 750_000 + 300_000 + 150_000 + 2_000 + 120_000 + 2_000_000,
    );
    // each dimension really contributes
    const base = worstCaseMicroUsd(card, { inputTokens: 1, maxOutputTokens: 1 });
    expect(worstCaseMicroUsd(card, { inputTokens: 1, maxOutputTokens: 1, cacheWriteTokens: 1_000_000 })).toBe(base + 3_750_000);
    expect(worstCaseMicroUsd(card, { inputTokens: 1, maxOutputTokens: 1, reasoningTokens: 1_000_000 })).toBe(base + 15_000_000);
    expect(worstCaseMicroUsd(card, { inputTokens: 1, maxOutputTokens: 1, calls: 1 })).toBe(base + 1_000);
  });

  it("rounds_each_dimension_up_to_whole_micro_usd", () => {
    // 1 token at $3/MTok = 3 micro-USD exactly; at 1 micro/MTok it is 0.000001 -> rounds up to 1.
    const tiny: PriceCard = { inputPerMTokMicro: 1, outputPerMTokMicro: 1 };
    expect(worstCaseMicroUsd(tiny, { inputTokens: 1, maxOutputTokens: 1 })).toBe(2); // 1 + 1, not 0 and not ceil(sum)=1
    expect(worstCaseMicroUsd(tiny, { inputTokens: 1_000_000, maxOutputTokens: 0 })).toBe(1);
    expect(worstCaseMicroUsd(tiny, { inputTokens: 1_000_001, maxOutputTokens: 0 })).toBe(2);
    expect(worstCaseMicroUsd(tiny, { inputTokens: 0, maxOutputTokens: 0 })).toBe(0);
  });

  it("unpriced_card_is_refused", () => {
    expect(() => worstCaseMicroUsd(undefined, { inputTokens: 1, maxOutputTokens: 1 })).toThrow(UnpricedCallError);
  });

  it("missing_dimension_price_is_refused", () => {
    const bare: PriceCard = { inputPerMTokMicro: 1_000, outputPerMTokMicro: 1_000 };
    const u = { inputTokens: 10, maxOutputTokens: 10 };
    expect(worstCaseMicroUsd(bare, u)).toBeGreaterThan(0);
    for (const extra of [
      { reasoningTokens: 1 },
      { cacheWriteTokens: 1 },
      { cacheReadTokens: 1 },
      { calls: 1 },
      { images: 1 },
      { videoSeconds: 1 },
    ]) {
      expect(() => worstCaseMicroUsd(bare, { ...u, ...extra }), JSON.stringify(extra)).toThrow(UnpricedCallError);
    }
    // an unused dimension (0) does not need a price
    expect(() => worstCaseMicroUsd(bare, { ...u, reasoningTokens: 0, calls: 0, images: 0 })).not.toThrow();
  });

  it("huge_token_count_is_exact_or_rangeerror", () => {
    const big: PriceCard = { inputPerMTokMicro: 3_000_000, outputPerMTokMicro: 1 };
    // tokens*price = 9e15*3e6 = 2.7e22 overflows doubles but the answer 2.7e16 > 2^53 -> RangeError
    expect(() => worstCaseMicroUsd(big, { inputTokens: 9_000_000_000_000_000, maxOutputTokens: 0 })).toThrow(RangeError);
    // product exceeds 2^53 but the result is small and must be exact
    const cheap: PriceCard = { inputPerMTokMicro: 1_000_000, outputPerMTokMicro: 1 };
    expect(worstCaseMicroUsd(cheap, { inputTokens: 9_007_199_254_740_991, maxOutputTokens: 0 })).toBe(9_007_199_254_740_991);
  });

  it("invalid_numbers_throw_rangeerror", () => {
    expect(() => worstCaseMicroUsd(card, { inputTokens: -1, maxOutputTokens: 0 })).toThrow(RangeError);
    expect(() => worstCaseMicroUsd(card, { inputTokens: 1.5, maxOutputTokens: 0 })).toThrow(RangeError);
    expect(() => worstCaseMicroUsd(card, { inputTokens: NaN, maxOutputTokens: 0 })).toThrow(RangeError);
    expect(() => worstCaseMicroUsd(card, { inputTokens: 0, maxOutputTokens: Infinity })).toThrow(RangeError);
    expect(() => worstCaseMicroUsd({ ...card, inputPerMTokMicro: -1 }, { inputTokens: 1, maxOutputTokens: 0 })).toThrow(RangeError);
  });
});

describe("callKey", () => {
  it("call_key_is_stable", () => {
    expect(callKey("abc", 2, 5)).toBe("abc:2:5");
    expect(callKey("abc", 2, 5)).toBe(callKey("abc", 2, 5));
    expect(callKey("abc", 2, 5)).not.toBe(callKey("abc", 5, 2));
    expect(callKey("abc", 1, 12)).not.toBe(callKey("abc", 11, 2));
  });
});
