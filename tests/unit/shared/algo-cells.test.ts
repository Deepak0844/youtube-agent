import { describe, expect, it } from "vitest";
import { validateScenes } from "@/shared/scene";
import { cellsAt } from "../../../remotion/kit/helpers";

const a = {
  id: "s1", beat: "b1", kind: "algo_cells", startMs: 0, durationMs: 6000, cells: ["5", "2", "9", "1"],
  steps: [
    { at: 500, type: "compare", i: 0, j: 1 },
    { at: 1500, type: "swap", i: 0, j: 1 },
    { at: 2500, type: "pointer", i: 2 },
    { at: 3500, type: "mark_done", i: 3 },
  ],
};
const doc = (s: unknown) => ({ version: 1, scenes: [s] });
const errs = (s: unknown) => {
  const r = validateScenes(doc(s));
  return r.ok ? [] : r.errors;
};

describe("algo_cells schema", () => {
  it("accepts a valid scene and defaults steps", () => {
    expect(validateScenes(doc(a)).ok).toBe(true);
    expect(validateScenes(doc({ ...a, steps: undefined })).ok).toBe(true);
  });
  it("bounds cells, text and steps", () => {
    expect(errs({ ...a, cells: ["1"] })[0]).toContain("at least 2 cells");
    expect(errs({ ...a, cells: Array(11).fill("1") })[0]).toContain("at most 10 cells");
    expect(errs({ ...a, cells: ["1", "1234567"] })[0]).toBe("scene 1 > cells > 1: must be at most 6 characters");
    expect(errs({ ...a, steps: Array(25).fill({ at: 0, type: "highlight", i: 0 }) })[0]).toContain("at most 24 steps");
  });
  it("rejects bad steps in plain text", () => {
    expect(errs({ ...a, steps: [{ at: 0, type: "run_code", i: 0 }] }).length).toBe(1);
    expect(errs({ ...a, steps: [{ at: 0, type: "highlight", i: 4 }] })).toEqual(["scene 1 > steps > 0 > i: must be a cell index from 0 to 3"]);
    expect(errs({ ...a, steps: [{ at: 0, type: "swap", i: 0 }] })).toEqual(["scene 1 > steps > 0 > j: is required for swap"]);
    expect(errs({ ...a, steps: [{ at: 0, type: "swap", i: 1, j: 1 }] })[0]).toContain("must differ");
    expect(errs({ ...a, steps: [{ at: 0, type: "pointer", i: 0, j: 1 }] })[0]).toContain("only for compare and swap");
    expect(errs({ ...a, steps: [{ at: 900, type: "highlight", i: 0 }, { at: 100, type: "highlight", i: 1 }] })[0]).toContain("time order");
    expect(errs({ ...a, steps: [{ at: 6000, type: "highlight", i: 0 }] })[0]).toContain("before the scene ends");
  });
});

describe("cellsAt", () => {
  const c = ["5", "2", "9", "1"];
  it("is untouched before the first step", () => {
    expect(cellsAt(c, a.steps as never, 0)).toEqual({ values: c, active: [], pointer: null, done: [] });
  });
  it("compare lights two cells, swap exchanges them", () => {
    expect(cellsAt(c, a.steps as never, 600).active).toEqual([0, 1]);
    const s = cellsAt(c, a.steps as never, 1600);
    expect(s.values).toEqual(["2", "5", "9", "1"]);
    expect(s.active).toEqual([0, 1]);
  });
  it("pointer persists, mark_done accumulates, pointer clears highlight", () => {
    const s = cellsAt(c, a.steps as never, 4000);
    expect(s.pointer).toBe(2);
    expect(s.done).toEqual([3]);
    expect(s.active).toEqual([]);
  });
});
