import { describe, expect, it } from "vitest";
import { isPriced, quote } from "@/server/core/media-catalog";

describe("media price rules", () => {
  it("quote_rounds_up_and_never_returns_float", () => {
    expect(quote({ unit: "per_1k_chars", microUsd: 300_000 }, 1)).toBe(300);
    expect(quote({ unit: "per_1k_chars", microUsd: 333 }, 1)).toBe(1);
    expect(quote({ unit: "per_second", microUsd: 7 }, 2.2)).toBe(16);
    expect(Number.isInteger(quote({ unit: "per_call", microUsd: 3 }, 0.1))).toBe(true);
    expect(quote({ unit: "free", microUsd: 0 }, 99)).toBe(0);
    expect(quote({ unit: "per_second", microUsd: 1 }, 11.000000000000002)).toBe(11);
    expect(quote({ unit: "per_call", microUsd: 10 }, 1.1)).toBe(11);
    expect(() => quote({ unit: "per_call", microUsd: Number.MAX_SAFE_INTEGER }, 10)).toThrow(RangeError);
    for (const bad of [-1, NaN, Infinity]) expect(() => quote({ unit: "per_call", microUsd: 1 }, bad)).toThrow(RangeError);
  });

  it("unpriced_provider_is_refused_before_reserve", () => {
    for (const bad of [undefined, null, {}, "x", { unit: "per_call" }, { unit: "per_call", microUsd: -1 }, { unit: "per_call", microUsd: 1.5 }, { unit: "weird", microUsd: 1 }]) {
      expect(isPriced(bad)).toBe(false);
    }
    expect(isPriced({ unit: "free", microUsd: 0 })).toBe(true);
    expect(isPriced({ unit: "per_image", microUsd: 40_000 })).toBe(true);
  });
});
