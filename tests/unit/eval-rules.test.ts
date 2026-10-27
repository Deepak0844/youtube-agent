import { describe, expect, it } from "vitest";
import { badgeFor, classifyFailure, decideDraftMode, evalCeilingMicroUsd, p50, type EvalRunSummary } from "@/server/core/eval-rules";

const run = (over: Partial<EvalRunSummary> = {}): EvalRunSummary => ({
  modeTested: "agent",
  startedAt: new Date("2026-10-01T00:00:00Z"),
  topics: 10,
  valid: 10,
  evidenceValid: 10,
  costMicroUsd: 1_000_000,
  ...over,
});

describe("decideDraftMode", () => {
  it("agent_mode_needs_8_of_10_valid", () => {
    expect(decideDraftMode([run({ evidenceValid: 8 })])).toBe("agent");
    expect(decideDraftMode([run({ evidenceValid: 7 })])).toBe("search_then_write");
    expect(decideDraftMode([run({ evidenceValid: 10 })])).toBe("agent");
  });

  it("a_model_never_evaluated_stays_search_then_write", () => {
    expect(decideDraftMode([])).toBe("search_then_write");
  });

  it("a_search_then_write_run_never_proves_agent_mode", () => {
    expect(decideDraftMode([run({ modeTested: "search_then_write", evidenceValid: 10 })])).toBe("search_then_write");
  });

  it("a_partial_or_short_run_never_proves_agent_mode", () => {
    expect(decideDraftMode([run({ topics: 5, valid: 5, evidenceValid: 5 })])).toBe("search_then_write");
    expect(decideDraftMode([run({ topics: 9, valid: 9, evidenceValid: 9 })])).toBe("search_then_write");
  });

  it("only_the_latest_agent_run_counts_and_a_stale_better_one_is_ignored", () => {
    const old = run({ startedAt: new Date("2026-09-01T00:00:00Z"), evidenceValid: 10 });
    const newer = run({ startedAt: new Date("2026-10-02T00:00:00Z"), evidenceValid: 4 });
    expect(decideDraftMode([old, newer])).toBe("search_then_write");
    expect(decideDraftMode([newer, old])).toBe("search_then_write");
    const recovered = run({ startedAt: new Date("2026-10-03T00:00:00Z"), evidenceValid: 9 });
    expect(decideDraftMode([old, newer, recovered])).toBe("agent");
  });

  it("garbage_counts_never_prove_agent_mode", () => {
    expect(decideDraftMode([run({ evidenceValid: Number.NaN })])).toBe("search_then_write");
    expect(decideDraftMode([run({ valid: 7, evidenceValid: 9 })])).toBe("search_then_write");
    expect(decideDraftMode([run({ topics: 10.5 })])).toBe("search_then_write");
  });
});

describe("badgeFor", () => {
  it("badge_shows_the_latest_agent_run_and_never_a_stale_better_one", () => {
    const old = run({ startedAt: new Date("2026-09-01T00:00:00Z"), evidenceValid: 10 });
    const newer = run({ startedAt: new Date("2026-10-02T00:00:00Z"), evidenceValid: 4, costMicroUsd: 1_500_000 });
    expect(badgeFor([old, newer])).toMatchObject({ mode: "search_then_write", label: "search-then-write", detail: "agent run 4/10" });
    expect(badgeFor([old])).toMatchObject({ mode: "agent", label: "agent mode proven 10/10", costMicroUsd: 1_000_000 });
  });
  it("no_runs_means_no_badge", () => {
    expect(badgeFor([])).toBeNull();
  });
});

describe("helpers", () => {
  it("failures_that_only_touch_evidence_leave_the_script_valid", () => {
    expect(classifyFailure(["claim 1: source_url was not fetched in this run"]).scriptValid).toBe(true);
    expect(classifyFailure(["claim 1: x", "narration is too short"]).scriptValid).toBe(false);
    expect(classifyFailure([]).scriptValid).toBe(false);
  });
  it("the_ceiling_is_the_lower_of_the_budget_cap_and_max_usd", () => {
    expect(evalCeilingMicroUsd(2_000_000, 5)).toBe(2_000_000);
    expect(evalCeilingMicroUsd(2_000_000, 0.5)).toBe(500_000);
    expect(() => evalCeilingMicroUsd(2_000_000, 0)).toThrow();
    expect(() => evalCeilingMicroUsd(2_000_000, Number.NaN)).toThrow();
  });
  it("p50_is_the_median_and_zero_for_nothing", () => {
    expect(p50([])).toBe(0);
    expect(p50([30, 10, 20])).toBe(20);
    expect(p50([10, 20, 30, 40])).toBe(25);
  });
});
