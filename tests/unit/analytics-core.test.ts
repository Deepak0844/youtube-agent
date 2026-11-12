import { describe, expect, it } from "vitest";
import { MIN_SHORTS_FOR_SIGNAL, beatSpans, channelSubsUrl, parseSubs, subsWindow, dropOff, isNoise, parseRetention, parseStats, parseTotals, retentionAt, retentionUrl, statsUrl, totalsUrl } from "@/server/core/analytics";

describe("analytics parsing", () => {
  it("reads statistics (strings), a hidden like count stays null, bad ids are dropped", () => {
    const m = parseStats({ items: [{ id: "abc_123", statistics: { viewCount: "40", commentCount: "2" } }, { id: "bad id!", statistics: {} }, { statistics: {} }] });
    expect([...m.keys()]).toEqual(["abc_123"]);
    expect(m.get("abc_123")).toEqual({ views: 40, likes: null, comments: 2 });
    expect(parseStats(null).size).toBe(0);
  });
  it("reads totals by column name, and no row means all null", () => {
    const h = [{ name: "views" }, { name: "estimatedMinutesWatched" }, { name: "averageViewPercentage" }];
    expect(parseTotals({ columnHeaders: h, rows: [[10, 4.5, 62.5]] })).toEqual({ views: 10, minutesWatched: 4.5, avgViewPct: 62.5 });
    expect(parseTotals({ columnHeaders: h, rows: [] })).toEqual({ views: null, minutesWatched: null, avgViewPct: null });
    expect(parseTotals("x").views).toBeNull();
  });
  it("builds the urls with the video filter and encodes ids", () => {
    expect(statsUrl(["a", "b"])).toContain("id=a,b");
    expect(decodeURIComponent(totalsUrl("v1", "2026-01-01", "2026-01-09"))).toContain("filters=video==v1");
    expect(retentionUrl("v1", "2026-01-01", "2026-01-09")).toContain("dimensions=elapsedVideoTimeRatio");
  });
});

const curve = parseRetention({ rows: [[0.5, 0.6], [0, 1], [1, 0.2], [0.2, 0.9], [2, 5], ["x", 1]] });

describe("retention curve", () => {
  it("sorts and drops rows outside 0..1 or not numbers", () => expect(curve).toEqual([[0, 1], [0.2, 0.9], [0.5, 0.6], [1, 0.2]]));
  it("interpolates and returns null outside the curve", () => {
    expect(retentionAt(curve, 0.1)).toBeCloseTo(0.95);
    expect(retentionAt(curve, 0.5)).toBe(0.6);
    expect(retentionAt([[0.2, 1]], 0.1)).toBeNull();
    expect(retentionAt([], 0.1)).toBeNull();
  });
});

describe("beat spans and drop-off", () => {
  const beats = [{ id: "hook", text: "aaaa" }, { id: "reveal", text: "bbbbbbbb" }];
  it("splits by line length without scene timings, ending exactly at 1", () => {
    const s = beatSpans(beats);
    expect(s[0]!.from).toBe(0);
    expect(s[0]!.to).toBeCloseTo(1 / 3);
    expect(s[1]!.to).toBe(1);
  });
  it("uses scene timings when every beat has them", () => {
    const s = beatSpans(beats, { scenes: [{ beat: "hook", startMs: 0, durationMs: 1000 }, { beat: "reveal", startMs: 1000, durationMs: 3000 }] });
    expect(s).toEqual([{ id: "hook", from: 0, to: 0.25 }, { id: "reveal", from: 0.25, to: 1 }]);
  });
  it("falls back to line length when a beat has no scene", () => {
    expect(beatSpans(beats, { scenes: [{ beat: "hook", startMs: 0, durationMs: 1000 }] })[0]!.to).toBeCloseTo(1 / 3);
    expect(beatSpans(null)).toEqual([]);
  });
  it("finds retention at 10% and the beat with the biggest fall", () => {
    const d = dropOff(curve, [{ id: "hook", from: 0, to: 0.2 }, { id: "mid", from: 0.2, to: 0.5 }, { id: "end", from: 0.5, to: 1 }]);
    expect(d.retentionAt10).toBeCloseTo(0.95);
    expect(d.biggestDropBeat).toBe("end");
    expect(d.biggestDrop).toBe(0.4);
  });
  it("gives nulls for an empty curve", () => expect(dropOff([], beatSpans(beats))).toEqual({ retentionAt10: null, biggestDropBeat: null, biggestDrop: null }));
  it("treats fewer than the minimum shorts as noise", () => {
    expect(MIN_SHORTS_FOR_SIGNAL).toBe(10);
    expect(isNoise(9)).toBe(true);
    expect(isNoise(10)).toBe(false);
  });
});

describe("channel subscribers", () => {
  it("covers the 7 days ending 2 days before the pull day, across a month edge", () => {
    expect(subsWindow("2026-11-03")).toEqual({ start: "2026-10-26", end: "2026-11-01" });
  });
  it("asks for the whole channel's subscribers and reads them by column name", () => {
    const u = new URL(channelSubsUrl("2026-10-26", "2026-11-01"));
    expect(u.searchParams.get("metrics")).toBe("subscribersGained,subscribersLost");
    expect(u.searchParams.get("filters")).toBeNull();
    expect(parseSubs({ columnHeaders: [{ name: "subscribersLost" }, { name: "subscribersGained" }], rows: [[3, 20]] })).toEqual({ gained: 20, lost: 3 });
    expect(parseSubs({ columnHeaders: [], rows: [] })).toEqual({ gained: null, lost: null });
  });
});
