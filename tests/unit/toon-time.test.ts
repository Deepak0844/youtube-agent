import { describe, expect, it } from "vitest";
import { markProblem, resolveMark, type ToonTimeline } from "../../remotion/kit/toon/time";

const tl: ToonTimeline = {
  beats: [
    { startS: 0, endS: 2, cap: null },
    { startS: 2.5, endS: 4.5, cap: null },
  ],
  scenes: [{ id: "stall", startS: 0, endS: 2.4 }],
};

describe("toon beat marks", () => {
  it("resolves beat, end, percent, offset, scene and plain seconds", () => {
    expect(resolveMark("B1", tl)).toBe(2.5);
    expect(resolveMark("B1e", tl)).toBe(4.5);
    expect(resolveMark("B1%50", tl)).toBe(3.5);
    expect(resolveMark("B0+.3", tl)).toBeCloseTo(0.3);
    expect(resolveMark("B1-.5", tl)).toBe(2);
    expect(resolveMark("stall", tl)).toBe(0);
    expect(resolveMark("stalle", tl)).toBe(2.4);
    expect(resolveMark("stall+.4", tl)).toBeCloseTo(0.4);
    expect(resolveMark("S0+1", tl)).toBe(1);
    expect(resolveMark(1.25, tl)).toBe(1.25);
    expect(resolveMark("1.25", tl)).toBe(1.25);
  });
  it("refuses a beat past the end and a bad mark with a plain message", () => {
    expect(() => resolveMark("B2", tl)).toThrow("no beat B2 (beats: 2)");
    expect(() => resolveMark("B99", tl)).toThrow("no beat B99 (beats: 2)");
    expect(() => resolveMark("B1%x", tl)).toThrow("bad time B1%x");
    expect(() => resolveMark("nope", tl)).toThrow("bad time nope");
    expect(() => resolveMark("S3", tl)).toThrow("no scene S3");
  });
  it("markProblem returns the message instead of throwing", () => {
    expect(markProblem("B1%x", tl)).toContain("bad time");
    expect(markProblem("B9", tl)).toBe("no beat B9 (beats: 2)");
    expect(markProblem("B1e", tl)).toBeNull();
  });
});
