import { describe, expect, it } from "vitest";
import { MIN_VIEWS, concludeTitleTest, twoSidedP } from "@/server/core/title-test";

describe("twoSidedP", () => {
  it("equal_daily_rates_give_p_near_1", () => expect(twoSidedP(100, 7, 100, 7)).toBeCloseTo(1, 5));
  it("no_views_or_no_days_gives_1", () => {
    expect(twoSidedP(0, 7, 0, 7)).toBe(1);
    expect(twoSidedP(10, 0, 10, 7)).toBe(1);
  });
  it("a_big_gap_gives_a_tiny_p", () => expect(twoSidedP(100, 7, 400, 7)).toBeLessThan(0.001));
  it("gives_the_textbook_p_for_120_vs_160", () => expect(twoSidedP(120, 7, 160, 7)).toBeCloseTo(0.0168, 3)); // z = 2.39
});

describe("concludeTitleTest", () => {
  const a = (views: number) => ({ views, days: 7, avgViewPct: 60 });
  it("always_says_it_is_confounded", () => expect(concludeTitleTest(a(300), a(300)).confounded).toBe(true));
  it("refuses_to_guess_on_thin_data", () => {
    const r = concludeTitleTest(a(MIN_VIEWS / 2 - 1), a(MIN_VIEWS / 2 - 1));
    expect(r.verdict).toBe("no_conclusion");
    expect(r.reason).toContain("needs 200");
  });
  it("b_better_needs_p_under_005_and_20_percent", () => {
    expect(concludeTitleTest(a(300), a(450))).toMatchObject({ verdict: "b_better", relDiff: 0.5 });
  });
  it("a_better_when_a_wins", () => expect(concludeTitleTest(a(450), a(300)).verdict).toBe("a_better"));
  it("a_small_difference_is_no_conclusion_even_if_significant", () => {
    expect(concludeTitleTest(a(5000), a(5400)).verdict).toBe("no_conclusion"); // +8%
  });
  it("a_big_difference_on_few_views_is_no_conclusion_when_p_is_high", () => {
    expect(concludeTitleTest(a(100), a(125)).verdict).toBe("no_conclusion"); // +25%, p ~ 0.1
  });
  it("zero_views_in_a_is_no_conclusion", () => expect(concludeTitleTest(a(0), a(300)).verdict).toBe("no_conclusion"));
});
