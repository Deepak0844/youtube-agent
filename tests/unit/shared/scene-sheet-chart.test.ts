import { describe, expect, it } from "vitest";
import { validateScenes } from "@/shared/scene";
import { cellRange, niceMax, pieSlices } from "../../../remotion/kit/helpers";

const sheet = {
  id: "s1", beat: "b1", kind: "spreadsheet", startMs: 0, durationMs: 4000,
  rows: [["Item", "Qty"], ["Apple", "3"], ["Pear", "5"]],
  formula: "=SUM(B2:B3)", highlight: ["B2:B3"],
};
const chart = {
  id: "s2", beat: "b2", kind: "chart", startMs: 0, durationMs: 4000,
  chart: "bar", labels: ["Mon", "Tue", "Wed"], series: [{ name: "Views", values: [3, 5, 8] }],
};
const doc = (s: unknown) => ({ version: 1, scenes: [s] });
const errs = (s: unknown) => {
  const r = validateScenes(doc(s));
  return r.ok ? [] : r.errors;
};

describe("spreadsheet scene", () => {
  it("accepts a valid sheet and defaults reveal", () => {
    const r = validateScenes(doc(sheet));
    expect(r.ok).toBe(true);
    if (r.ok && r.doc.scenes[0]?.kind === "spreadsheet") expect(r.doc.scenes[0].reveal).toBe("row");
  });
  it("bounds rows, cols and cell length", () => {
    expect(errs({ ...sheet, rows: Array(9).fill(["a"]) })[0]).toContain("at most 8 rows");
    expect(errs({ ...sheet, rows: [["a", "b", "c", "d", "e"]] })[0]).toContain("at most 4 columns");
    expect(errs({ ...sheet, rows: [["x".repeat(17)]], highlight: [] })[0]).toContain("at most 16 characters");
  });
  it("requires equal row lengths", () => {
    expect(errs({ ...sheet, rows: [["a", "b"], ["c"]], highlight: [] })[0]).toContain("same number of cells");
  });
  it("rejects bad or out-of-grid highlights", () => {
    expect(errs({ ...sheet, highlight: ["D1"] })[0]).toContain("outside the 2 x 3 grid");
    expect(errs({ ...sheet, highlight: ["b2"] })[0]).toContain("like 'B2' or 'A1:B3'");
    expect(errs({ ...sheet, highlight: ["A1", "A2", "A3", "B1", "B2"] }).length).toBe(1);
  });
  it("rejects empty cell grid", () => {
    expect(errs({ ...sheet, rows: [], highlight: [] }).length).toBe(1);
  });
});

describe("chart scene", () => {
  it("accepts bar, line, pie", () => {
    for (const c of ["bar", "line", "pie"]) expect(errs({ ...chart, chart: c })).toEqual([]);
  });
  it("rejects unknown chart type", () => {
    expect(errs({ ...chart, chart: "radar" }).length).toBe(1);
  });
  it("bounds points, series and labels", () => {
    const n = 9;
    expect(errs({ ...chart, labels: Array(n).fill("a"), series: [{ values: Array(n).fill(1) }] })[0]).toContain("at most 8");
    const s = { values: [1, 2, 3] };
    expect(errs({ ...chart, series: [s, s, s, s] })[0]).toContain("at most 3");
    expect(errs({ ...chart, labels: ["x".repeat(13), "b", "c"] })[0]).toContain("at most 12 characters");
  });
  it("rejects bad numbers", () => {
    for (const v of [Number.NaN, Infinity, -1, 1e10, "5" as unknown as number]) {
      expect(errs({ ...chart, series: [{ values: [1, v, 3] }] }).length, String(v)).toBeGreaterThan(0);
    }
  });
  it("requires one value per label", () => {
    expect(errs({ ...chart, series: [{ values: [1, 2] }] })[0]).toContain("one value per label");
  });
  it("pie needs exactly one series with a positive total", () => {
    expect(errs({ ...chart, chart: "pie", series: [{ values: [1, 2, 3] }, { values: [1, 2, 3] }] })[0]).toContain("exactly one series");
    expect(errs({ ...chart, chart: "pie", series: [{ values: [0, 0, 0] }] })[0]).toContain("add up to more than 0");
  });
});

describe("kit helpers for sheet and chart", () => {
  it("cellRange parses cells and ranges, normalises order", () => {
    expect(cellRange("B2")).toEqual({ c1: 1, r1: 1, c2: 1, r2: 1 });
    expect(cellRange("C3:A1")).toEqual({ c1: 0, r1: 0, c2: 2, r2: 2 });
    expect(cellRange("nope")).toBeNull();
  });
  it("niceMax rounds up to a tidy axis top", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(8)).toBe(10);
    expect(niceMax(120)).toBe(200);
    expect(niceMax(Number.NaN)).toBe(1);
  });
  it("pieSlices are fractions that sum to 1, zero-safe", () => {
    expect(pieSlices([1, 1, 2])).toEqual([0.25, 0.25, 0.5]);
    expect(pieSlices([0, 0])).toEqual([0, 0]);
  });
});
