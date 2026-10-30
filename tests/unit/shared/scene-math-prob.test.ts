import { describe, expect, it } from "vitest";
import { describeSceneFormat, validateScenes } from "@/shared/scene";
import { mathReveal, tallyAt } from "../../../remotion/kit/helpers";

const m = { id: "m1", beat: "b1", kind: "math", startMs: 0, durationMs: 4000, steps: [{ text: "2x + 3 = 11" }, { text: "2x = 8", highlight: "8" }, { text: "x = 4" }] };
const p = {
  id: "p1", beat: "b2", kind: "probability", startMs: 4000, durationMs: 4000, experiment: "coin", trials: 10,
  outcomes: [{ label: "Heads", count: 6, p: 0.5 }, { label: "Tails", count: 4, p: 0.5 }],
};
const doc = (...scenes: unknown[]) => ({ version: 1, scenes });
const errs = (d: unknown) => {
  const r = validateScenes(d);
  return r.ok ? [] : r.errors;
};

describe("math kind", () => {
  it("accepts steps with a highlight", () => expect(validateScenes(doc(m)).ok).toBe(true));
  it("rejects LaTeX, HTML and code characters", () => {
    for (const text of ["\\frac{1}{2}", "<b>x</b>", "$x$", "a; b", "`x`"]) {
      expect(errs(doc({ ...m, steps: [{ text }] })).length, text).toBe(1);
    }
  });
  it("highlight must be part of the line", () => {
    expect(errs(doc({ ...m, steps: [{ text: "x = 4", highlight: "9" }] }))).toEqual(["scene 1 > steps > 0 > highlight: must appear in the text of the same line"]);
  });
  it("bounds the number and length of steps", () => {
    expect(errs(doc({ ...m, steps: [] })).length).toBe(1);
    expect(errs(doc({ ...m, steps: Array(7).fill({ text: "x" }) }))[0]).toContain("at most 6");
    expect(errs(doc({ ...m, steps: [{ text: "1".repeat(41) }] }))[0]).toContain("at most 40 characters");
  });
  it("mathReveal counts revealed steps", () => {
    expect(mathReveal(0, 30, 3)).toBe(1);
    expect(mathReveal(65, 30, 3)).toBe(3);
  });
});

describe("probability kind", () => {
  it("accepts a coin run", () => expect(validateScenes(doc(p)).ok).toBe(true));
  it("rejects unknown experiment", () => expect(errs(doc({ ...p, experiment: "roulette" })).length).toBe(1));
  it("counts must be integers within 0..trials and sum to trials", () => {
    expect(errs(doc({ ...p, outcomes: [{ label: "H", count: 1.5 }, { label: "T", count: 8.5 }] })).length).toBeGreaterThan(0);
    expect(errs(doc({ ...p, outcomes: [{ label: "H", count: -1 }, { label: "T", count: 11 }] })).length).toBeGreaterThan(0);
    expect(errs(doc({ ...p, outcomes: [{ label: "H", count: 5 }, { label: "T", count: 4 }] }))).toEqual(["scene 1 > outcomes: counts add up to 9 but trials is 10"]);
  });
  it("bounds trials and outcomes", () => {
    expect(errs(doc({ ...p, trials: 0 })).length).toBeGreaterThan(0);
    expect(errs(doc({ ...p, trials: 501, outcomes: [{ label: "H", count: 501 }, { label: "T", count: 0 }] }))[0]).toContain("at most 500");
    expect(errs(doc({ ...p, outcomes: [{ label: "H", count: 10 }] })).length).toBe(1);
    expect(errs(doc({ ...p, outcomes: Array(7).fill({ label: "x", count: 0 }) }))[0]).toContain("at most 6");
  });
  it("p must be within 0..1", () => {
    expect(errs(doc({ ...p, outcomes: [{ label: "H", count: 6, p: 1.2 }, { label: "T", count: 4 }] }))[0]).toContain("p:");
    expect(errs(doc({ ...p, outcomes: [{ label: "H", count: 6, p: -0.1 }, { label: "T", count: 4 }] }))[0]).toContain("p:");
  });
  it("tallyAt grows linearly to the final count", () => {
    expect(tallyAt(0, 60, 6)).toBe(0);
    expect(tallyAt(30, 60, 6)).toBe(3);
    expect(tallyAt(999, 60, 6)).toBe(6);
  });
});

it("prompt text mentions both new kinds", () => {
  const d = describeSceneFormat();
  expect(d).toContain('kind "math"');
  expect(d).toContain('kind "probability"');
});
