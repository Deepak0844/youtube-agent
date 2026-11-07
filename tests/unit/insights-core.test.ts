import { describe, expect, it } from "vitest";
import {
  buildReport, isoWeek, learningNotes, optimizerPrompt, parseObservations, parseProposals, retentionByBeat, reviewPrompt, shortBeatDrops,
  type ShortStat,
} from "@/server/core/insights";

const stat = (i: number, o: Partial<ShortStat> = {}): ShortStat => ({
  videoId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, topic: `topic ${i}`, niche: "tsx · en", views: 100 * i, avgViewPct: 50 + i,
  spendMicroUsd: 1_000_000, beatDrops: { hook: 0.1, body: 0.3 }, ...o,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => stat(i + 1));

describe("isoWeek", () => {
  it.each([["2026-11-07", "2026-W45"], ["2026-01-01", "2026-W01"], ["2024-12-30", "2025-W01"], ["2021-01-03", "2020-W53"]])("%s_is_%s", (d, w) => {
    expect(isoWeek(d)).toBe(w);
  });
});

describe("shortBeatDrops", () => {
  it("is_the_watch_ratio_lost_inside_each_beat", () => {
    const curve: Array<[number, number]> = [[0, 1], [0.5, 0.6], [1, 0.2]];
    const d = shortBeatDrops(curve, [{ id: "a", from: 0, to: 0.5 }, { id: "b", from: 0.5, to: 1 }]);
    expect(d.a).toBeCloseTo(0.4);
    expect(d.b).toBeCloseTo(0.4);
  });
  it("skips_a_beat_the_curve_does_not_cover", () => {
    expect(shortBeatDrops([[0, 1], [0.4, 0.5]], [{ id: "a", from: 0, to: 0.4 }, { id: "b", from: 0.4, to: 1 }])).toEqual({ a: 0.5 });
  });
});

describe("retentionByBeat", () => {
  it("averages_the_drop_per_beat_and_puts_the_worst_first", () => {
    const rows = retentionByBeat([stat(1), stat(2, { beatDrops: { hook: 0.3, body: 0.3 } })]);
    expect(rows.map((r) => r.beat)).toEqual(["body", "hook"]);
    expect(rows[0]).toMatchObject({ shorts: 2 });
    expect(rows[0]!.avgDrop).toBeCloseTo(0.3);
    expect(rows[1]!.avgDrop).toBeCloseTo(0.2);
  });
});

describe("buildReport", () => {
  const base = { week: "2026-W45", shipped: 3, failures: 1, spendMicroUsd: 3_000_000 };
  it("is_low_confidence_under_10_shorts", () => {
    const r = buildReport({ ...base, shorts: many(9) });
    expect(r.lowConfidence).toBe(true);
    expect(r.niches[0]!.lowConfidence).toBe(true);
  });
  it("is_not_low_confidence_at_10", () => expect(buildReport({ ...base, shorts: many(10) }).lowConfidence).toBe(false));
  it("works_out_totals_and_cost_per_short_from_the_numbers", () => {
    const r = buildReport({ ...base, shorts: [stat(1, { views: 100, avgViewPct: 40 }), stat(2, { views: 300, avgViewPct: 60 })] });
    expect(r).toMatchObject({ shipped: 3, views: 400, avgViewPct: 50, spendMicroUsd: 3_000_000, costPerShortMicroUsd: 1_000_000, failures: 1 });
  });
  it("has_no_cost_per_short_when_nothing_shipped", () => {
    expect(buildReport({ ...base, shipped: 0, spendMicroUsd: 0, shorts: [] })).toMatchObject({ costPerShortMicroUsd: null, avgViewPct: null, views: 0 });
  });
  it("builds_a_niche_table_with_one_row_per_niche", () => {
    const r = buildReport({ ...base, shorts: [stat(1), stat(2, { niche: "tsx · hi", views: null, avgViewPct: null })] });
    expect(r.niches.map((n) => n.niche).sort()).toEqual(["tsx · en", "tsx · hi"]);
  });
});

describe("learningNotes", () => {
  it("is_silent_below_the_minimum_sample", () => expect(learningNotes(many(9))).toEqual([]));
  it("names_the_beat_that_loses_the_most_viewers_at_10", () => {
    const n = learningNotes(many(10));
    expect(n).toHaveLength(1);
    expect(n[0]).toContain("body");
    expect(n[0]).toContain("30%");
  });
  it("counts_only_shorts_that_have_a_curve", () => {
    expect(learningNotes([...many(9), stat(10, { beatDrops: {} })])).toEqual([]);
  });
});

describe("model output is untrusted", () => {
  it("parseObservations_keeps_at_most_8_short_strings_and_drops_junk", () => {
    const text = `Sure! {"observations": ["a", 5, "${"x".repeat(500)}", "", "b", "c", "d", "e", "f", "g", "h"]}`;
    const o = parseObservations(text);
    expect(o).toHaveLength(8);
    expect(o.every((s) => s.length <= 300)).toBe(true);
  });
  it("parseObservations_gives_nothing_for_invalid_json", () => expect(parseObservations("no json")).toEqual([]));
  it("parseProposals_keeps_valid_ones_only_max_5_and_known_video_ids", () => {
    const known = stat(1).videoId;
    const items = [
      { kind: "title", video: known, title: "Better title", detail: "why", payload: { title: "New one" } },
      { kind: "hook", video: "not-a-known-id", title: "Rewrite hook", detail: "d", payload: {} },
      { kind: "spend", title: "nope", detail: "", payload: {} },
      { kind: "idea", title: "", detail: "", payload: {} },
      { kind: "policy", title: "Post later", detail: "d", payload: "str" },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: "idea", title: `idea ${i}`, detail: "d", payload: { topic: "t" } })),
    ];
    const p = parseProposals(JSON.stringify({ proposals: items }), [known]);
    expect(p).toHaveLength(5);
    expect(p[0]).toMatchObject({ kind: "title", videoId: known });
    expect(p[1]).toMatchObject({ kind: "hook", videoId: null });
    expect(p[2]).toMatchObject({ kind: "policy", payload: {} });
    expect(p.map((x) => x.kind)).not.toContain("spend");
  });
  it("prompts_label_the_numbers_as_data_and_forbid_spending", () => {
    const r = buildReport({ week: "2026-W45", shipped: 1, failures: 0, spendMicroUsd: 0, shorts: many(2) });
    expect(reviewPrompt(r)).toContain("DATA");
    expect(optimizerPrompt(r)).toMatch(/never propose spending/i);
  });
});
