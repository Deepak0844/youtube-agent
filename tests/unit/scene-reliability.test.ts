import { describe, expect, it } from "vitest";
import { BudgetRefusedError, KnownFailure } from "@/server/core/paid-call";
import { runSheets, selectSheets, summarize, type Ask, type BeatSheet } from "@/server/core/scene-reliability";
import { fixedSheets } from "@/server/db/scene-eval";
import { kinds } from "@/shared/scene/kinds";

const sheet = (id: string, kind: BeatSheet["kind"] = "terminal"): BeatSheet => ({ id, kind, beats: [{ id: "b1", text: "Show it." }] });
const GOOD = JSON.stringify({ version: 1, scenes: [{ id: "s1", kind: "chat_thread", beat: "b1", startMs: 0, durationMs: 2000, messages: [{ from: "user", text: "hi" }] }] });
const BAD = JSON.stringify({ version: 1, scenes: [{ id: "s1", kind: "chat_thread", beat: "b1", startMs: 0, durationMs: 10, messages: [{ from: "user", text: "hi" }] }] });
const reply = (text: string) => ({ text, inputTokens: 100, outputTokens: 50, costMicroUsd: 1000 });
const script = (...steps: Array<string | Error>): { ask: Ask; calls: number[] } => {
  const calls: number[] = [];
  let i = 0;
  const ask: Ask = async (m) => {
    calls.push(m.length);
    const s = steps[Math.min(i++, steps.length - 1)]!;
    if (s instanceof Error) throw s;
    return reply(s);
  };
  return { ask, calls };
};

describe("runSheets", () => {
  it("counts first-try passes", async () => {
    const { results, stopped } = await runSheets([sheet("a"), sheet("b")], script(GOOD).ask);
    expect(stopped).toBe("none");
    expect(results.map((r) => [r.firstTry, r.withinRetries, r.attempts])).toEqual([[true, true, 1], [true, true, 1]]);
    expect(results[0]).toMatchObject({ inputTokens: 100, outputTokens: 50, costMicroUsd: 1000 });
  });

  it("fixes on retry and feeds the plain errors back", async () => {
    const s = script(BAD, "not json", GOOD);
    const { results } = await runSheets([sheet("a")], s.ask);
    expect(results[0]).toMatchObject({ firstTry: false, withinRetries: true, attempts: 3, costMicroUsd: 3000 });
    expect(s.calls).toEqual([2, 4, 6]);
  });

  it("stops when the same error repeats", async () => {
    const s = script(BAD);
    const { results } = await runSheets([sheet("a")], s.ask);
    expect(results[0]).toMatchObject({ withinRetries: false, attempts: 2 });
    expect(results[0]!.errors[0]).toContain("at least 500 ms");
  });

  it("stops at the budget cap with a partial result", async () => {
    const s = script(GOOD, new BudgetRefusedError("k"));
    const { results, stopped } = await runSheets([sheet("a"), sheet("b"), sheet("c")], s.ask);
    expect(stopped).toBe("cap");
    expect(results).toHaveLength(1);
  });

  it("parks on an unclear outcome and never retries it", async () => {
    const s = script(new Error("socket hang up"));
    const { results, stopped } = await runSheets([sheet("a"), sheet("b")], s.ask);
    expect(stopped).toBe("unclear");
    expect(s.calls).toHaveLength(1);
    expect(results).toHaveLength(0);
  });

  it("counts a known failure as a failed run and carries on", async () => {
    const s = script(new KnownFailure("refused"), GOOD);
    const { results, stopped } = await runSheets([sheet("a"), sheet("b")], s.ask);
    expect(stopped).toBe("none");
    expect(results.map((r) => r.withinRetries)).toEqual([false, true]);
    expect(results[0]!.errors).toEqual(["refused"]);
  });
});

describe("summarize", () => {
  it("gives GO at 8 of 10 and lists top repeated errors", async () => {
    const sheets = Array.from({ length: 10 }, (_, i) => sheet(`s${i}`));
    let n = 0;
    const ask: Ask = async () => reply(n++ < 2 ? BAD : GOOD);
    const { results } = await runSheets(sheets, ask);
    const sum = summarize(results, 10);
    expect(sum.verdict).toBe("GO");
    expect(sum.withinRetries).toBe(9);
    expect(sum.topErrors[0]!.count).toBeGreaterThanOrEqual(1);
    expect(summarize(results.slice(0, 5), 10).verdict).toBe("NO-GO");
  });
});

describe("provider refusal", () => {
  it("is NOT RUN, not NO-GO, when every sheet is refused", async () => {
    const { results } = await runSheets([sheet("a"), sheet("b")], script(new KnownFailure("404 model not found")).ask);
    const sum = summarize(results, 2);
    expect(sum.verdict).toBe("NOT RUN");
    expect(sum.notRunReason).toBe("404 model not found");
  });
});

describe("per-kind reliability", () => {
  it("every registered kind has at least 2 beat sheets", () => {
    const have = new Map<string, number>();
    for (const s of fixedSheets()) have.set(s.kind, (have.get(s.kind) ?? 0) + 1);
    for (const k of Object.keys(kinds)) expect(have.get(k) ?? 0, `fixtures for ${k}`).toBeGreaterThanOrEqual(2);
  });

  it("summarize reports first-try and within-retries by kind", () => {
    const r = (id: string, kind: BeatSheet["kind"], firstTry: boolean, withinRetries: boolean) => ({ id, kind, firstTry, withinRetries, attempts: 1, errors: [], inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
    const s = summarize([r("a", "chess", true, true), r("b", "chess", false, true), r("c", "map", false, false)], 3);
    expect(s.byKind).toEqual({ chess: { ran: 2, firstTry: 1, withinRetries: 2 }, map: { ran: 1, firstTry: 0, withinRetries: 0 } });
  });

  it("selectSheets picks n per kind, or the first N overall", () => {
    const all = fixedSheets();
    const per = selectSheets(all, { perKind: 1 });
    expect(per).toHaveLength(Object.keys(kinds).length);
    expect(new Set(per.map((s) => s.kind)).size).toBe(per.length);
    expect(selectSheets(all, { perKind: 2 }).length).toBe(Object.keys(kinds).length * 2);
    expect(selectSheets(all, { runs: 3 })).toEqual(all.slice(0, 3));
    expect(selectSheets(all, {})).toEqual(all.slice(0, 10));
  });
});
