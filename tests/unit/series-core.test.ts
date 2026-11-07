import { describe, expect, it } from "vitest";
import { capStatus, nextPartNo, parseEpisodeList, parseSeriesForm, swapTarget } from "@/server/core/series";

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("parseSeriesForm", () => {
  it("cleans text and turns dollars into micro-USD", () => {
    const r = parseSeriesForm(form({ title: "  Data​ structures \n 101 ", premise: "Short\tlessons", language: "en", formats: "short", capUsd: "2.50" }));
    expect(r).toEqual({ ok: true, value: { title: "Data structures 101", premise: "Short lessons", channelId: null, language: "en", formats: "short", capMicroUsd: 2_500_000, settings: {} } });
  });
  it("blank cap means no limit; zero is a real cap", () => {
    expect(parseSeriesForm(form({ title: "Series one", capUsd: "" }))).toMatchObject({ ok: true, value: { capMicroUsd: null } });
    expect(parseSeriesForm(form({ title: "Series one", capUsd: "0" }))).toMatchObject({ ok: true, value: { capMicroUsd: 0 } });
  });
  it("refuses short titles, bad caps, unknown languages and unknown styles", () => {
    expect(parseSeriesForm(form({ title: "ab" }))).toMatchObject({ ok: false });
    expect(parseSeriesForm(form({ title: "Series one", capUsd: "-1" }))).toMatchObject({ ok: false });
    expect(parseSeriesForm(form({ title: "Series one", capUsd: "abc" }))).toMatchObject({ ok: false });
    expect(parseSeriesForm(form({ title: "Series one", language: "xx" }))).toMatchObject({ ok: false });
    expect(parseSeriesForm(form({ title: "Series one", style: "nope" }))).toMatchObject({ ok: false });
  });
  it("keeps only known settings", () => {
    const r = parseSeriesForm(form({ title: "Series one", style: "flat_motion", captionStyle: "punchy_captions", voice: "abc_123" }));
    expect(r).toMatchObject({ ok: true, value: { settings: { style: "flat_motion", captionStyle: "punchy_captions", voice: "abc_123" } } });
    expect(parseSeriesForm(form({ title: "Series one", voice: "bad voice!" }))).toMatchObject({ ok: false });
  });
  it("rejects a channel id with odd characters", () => {
    expect(parseSeriesForm(form({ title: "Series one", channel: "a b;" }))).toMatchObject({ ok: false });
  });
});

describe("parseEpisodeList", () => {
  it("reads title and one line, ignoring numbering and blanks", () => {
    const r = parseEpisodeList("1. Arrays - How memory is laid out\n\n2) Hash maps | One step lookup\n- Trees\n");
    expect(r).toEqual({ ok: true, value: [{ title: "Arrays", oneLine: "How memory is laid out" }, { title: "Hash maps", oneLine: "One step lookup" }, { title: "Trees", oneLine: "" }] });
  });
  it("refuses an empty list and more than 50 lines", () => {
    expect(parseEpisodeList("  \n ")).toMatchObject({ ok: false });
    expect(parseEpisodeList(Array.from({ length: 51 }, (_, i) => `Part ${i}`).join("\n"))).toMatchObject({ ok: false });
  });
  it("cleans control characters and cuts long titles", () => {
    const r = parseEpisodeList(`A‮b${"x".repeat(300)}`);
    expect(r.ok && r.value[0]!.title.length).toBe(200);
    expect(r.ok && r.value[0]!.title.includes("‮")).toBe(false);
  });
});

describe("nextPartNo", () => {
  it("is one more than the highest, dropped parts included", () => {
    expect(nextPartNo([])).toBe(1);
    expect(nextPartNo([1, 2, 5])).toBe(6);
  });
});

describe("swapTarget", () => {
  it("finds the planned neighbour in order", () => {
    expect(swapTarget([2, 3, 5], 3, "up")).toBe(2);
    expect(swapTarget([2, 3, 5], 3, "down")).toBe(5);
  });
  it("is null at the ends or for an unknown part", () => {
    expect(swapTarget([2, 3, 5], 2, "up")).toBeNull();
    expect(swapTarget([2, 3, 5], 5, "down")).toBeNull();
    expect(swapTarget([2, 3, 5], 4, "up")).toBeNull();
  });
});

describe("capStatus", () => {
  it("no cap is no limit", () => expect(capStatus(5_000_000, null)).toEqual({ state: "no_limit", pct: 0 }));
  it("ok, near at 80 percent, over at the cap", () => {
    expect(capStatus(1_000_000, 10_000_000)).toEqual({ state: "ok", pct: 10 });
    expect(capStatus(8_000_000, 10_000_000)).toEqual({ state: "near", pct: 80 });
    expect(capStatus(10_000_000, 10_000_000)).toEqual({ state: "over", pct: 100 });
    expect(capStatus(15_000_000, 10_000_000)).toEqual({ state: "over", pct: 100 });
  });
  it("a zero cap is always over", () => expect(capStatus(0, 0)).toEqual({ state: "over", pct: 100 }));
});
