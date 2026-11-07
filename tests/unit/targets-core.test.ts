import { describe, expect, it } from "vitest";
import { actuals, evaluate, overTargetForLast, revenueEstimateUsd, TARGET_MIN_SAMPLE, type ShortNumbers } from "@/server/core/targets";

const s = (views: number | null, spendUsd: number, pct: number | null = 60): ShortNumbers => ({ views, avgViewPct: pct, spendMicroUsd: spendUsd * 1e6 });

describe("actuals", () => {
  it("returns_null_values_with_no_shorts", () => {
    expect(actuals([])).toEqual({ avg_view_pct: { value: null, n: 0 }, views: { value: null, n: 0 }, cost_per_short: { value: null, n: 0 }, cost_per_1k_views: { value: null, n: 0 } });
  });
  it("computes_each_metric_from_the_shorts", () => {
    const a = actuals([s(1000, 2, 50), s(3000, 4, 70), s(null, 1, null)]);
    expect(a.avg_view_pct).toEqual({ value: 60, n: 2 });
    expect(a.views).toEqual({ value: 2000, n: 2 });
    expect(a.cost_per_short).toEqual({ value: 2.33, n: 3 });
    expect(a.cost_per_1k_views).toEqual({ value: 1.5, n: 2 }); // $6 over 4,000 views; the short with no views is left out
  });
});

describe("evaluate", () => {
  it("says_no_data_below_the_minimum_sample", () => {
    expect(evaluate({ value: 99, n: TARGET_MIN_SAMPLE - 1 }, ">=", 70)).toBe("no_data");
    expect(evaluate({ value: null, n: 99 }, ">=", 70)).toBe("no_data");
  });
  it("respects_the_direction", () => {
    expect(evaluate({ value: 71, n: 5 }, ">=", 70)).toBe("on_track");
    expect(evaluate({ value: 69, n: 5 }, ">=", 70)).toBe("behind");
    expect(evaluate({ value: 2, n: 5 }, "<=", 2)).toBe("on_track");
    expect(evaluate({ value: 2.01, n: 5 }, "<=", 2)).toBe("behind");
  });
});

describe("overTargetForLast", () => {
  const dear = s(1000, 5); // $5 per 1,000
  const cheap = s(1000, 1);
  it("is_off_when_n_is_zero", () => expect(overTargetForLast([dear, dear], 0, 1)).toBe(false));
  it("needs_n_shorts_with_views", () => expect(overTargetForLast([dear], 2, 1)).toBe(false));
  it("fires_only_when_every_one_of_the_last_n_is_over", () => {
    expect(overTargetForLast([cheap, dear, dear], 2, 2)).toBe(true);
    expect(overTargetForLast([dear, cheap, dear], 2, 2)).toBe(false);
  });
  it("skips_shorts_with_no_views", () => expect(overTargetForLast([dear, s(0, 9), dear], 2, 2)).toBe(true));
});

describe("revenueEstimateUsd", () => {
  it("is_null_without_an_rpm", () => expect(revenueEstimateUsd(5000, 0)).toBeNull());
  it("is_views_per_thousand_times_rpm", () => expect(revenueEstimateUsd(5000, 0.5)).toBe(2.5));
});
