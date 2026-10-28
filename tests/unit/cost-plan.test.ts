import { describe, expect, it } from "vitest";
import { liveHash } from "@/server/core/approvals";
import { buildCostPlan, costPlanBody, parseCostPlan, quoteHeadroom, sumMicroUsd } from "@/server/core/cost-plan";

const items = [
  { kind: "image" as const, provider: "fake-image", quoteMicroUsd: 4000 },
  { kind: "image" as const, provider: "fake-image", quoteMicroUsd: 4500 },
  { kind: "clip" as const, provider: "fake-clip", quoteMicroUsd: 1 },
];

describe("cost plan", () => {
  it("cost_plan_totals_and_quote_math_are_integer_micro_usd", () => {
    const plan = buildCostPlan(items, "scene_kit");
    expect(plan.totalMicroUsd).toBe(8501);
    const body = costPlanBody(plan);
    expect(body.quote).toEqual({ micro_usd: "8501" }); // a string, so it never passes through a float
    expect(body.totalMicroUsd).toBe(8501);
    const back = parseCostPlan(JSON.parse(JSON.stringify(body)));
    expect(back).toEqual({ ok: true, plan, quoteMicroUsd: 8501 });
    expect(sumMicroUsd([])).toBe(0);
    expect(sumMicroUsd([Number.MAX_SAFE_INTEGER, 0])).toBe(Number.MAX_SAFE_INTEGER);

    // Never a fraction, a negative, NaN or a number past 2^53: refused, not rounded.
    for (const bad of [0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => sumMicroUsd([bad])).toThrow(RangeError);
      expect(() => buildCostPlan([{ ...items[0]!, quoteMicroUsd: bad }], "scene_kit")).toThrow(RangeError);
    }
    expect(() => sumMicroUsd([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });

  it("the body passes the cost gate's own completeness check and names the providers", () => {
    const body = costPlanBody(buildCostPlan(items, "scene_kit"));
    expect(body.providers_models).toEqual({ clip: "fake-clip", image: "fake-image" });
    const r = liveHash("cost", { channelId: null, content: { cost_plan: { sha256: "a".repeat(64), body } } });
    expect(r.ok).toBe(true);
  });

  it("a different provider changes the cost hash", () => {
    const hash = (provider: string) => {
      const body = costPlanBody(buildCostPlan([{ kind: "image", provider, quoteMicroUsd: 1 }], "scene_kit"));
      const r = liveHash("cost", { channelId: null, content: { cost_plan: { sha256: "a".repeat(64), body } } });
      return r.ok ? r.hash : "";
    };
    expect(hash("fake-image")).not.toBe(hash("other-image"));
  });

  it("parse refuses a plan whose items cost more than its quote, or whose figures disagree", () => {
    const good = costPlanBody(buildCostPlan(items, "scene_kit"));
    expect(parseCostPlan({ ...good, quote: { micro_usd: "8500" } }).ok).toBe(false); // items exceed the quote
    expect(parseCostPlan({ ...good, totalMicroUsd: 1 }).ok).toBe(false);
    expect(parseCostPlan({ ...good, quote: { micro_usd: "85.01" } }).ok).toBe(false);
    expect(parseCostPlan({ ...good, quote: { micro_usd: "9007199254740993" } }).ok).toBe(false);
    expect(parseCostPlan({ ...good, path: "nope" }).ok).toBe(false);
    expect(parseCostPlan({ ...good, items: [{ kind: "video", provider: "x", quoteMicroUsd: 1 }] }).ok).toBe(false);
    expect(parseCostPlan({ ...good, items: [{ kind: "image", provider: "", quoteMicroUsd: 1 }] }).ok).toBe(false);
    expect(parseCostPlan(null).ok).toBe(false);
    expect(parseCostPlan("x").ok).toBe(false);
  });

  it("headroom is the quote minus what is reserved and spent, never below zero", () => {
    expect(quoteHeadroom(1000, 300, 200)).toBe(500);
    expect(quoteHeadroom(1000, 900, 400)).toBe(0);
  });
});
