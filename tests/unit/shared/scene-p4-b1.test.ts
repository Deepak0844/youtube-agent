import { describe, expect, it } from "vitest";
import { validateScenes } from "@/shared/scene";

const doc = (...scenes: unknown[]) => ({ version: 1, scenes });
const b = { id: "s1", beat: "b1", startMs: 0, durationMs: 4000 };
const stock = { ...b, kind: "stock_clip", asset: "vid_ab12" };
const pause = { ...b, kind: "pause_card", question: "Which one is real?", options: ["A", "B"], answer: 1, revealAtMs: 3000 };
const errs = (d: unknown) => {
  const r = validateScenes(d);
  return r.ok ? [] : r.errors;
};

describe("stock_clip", () => {
  it("accepts and defaults dim", () => {
    const r = validateScenes(doc(stock));
    expect(r.ok).toBe(true);
    if (r.ok && r.doc.scenes[0]?.kind === "stock_clip") expect(r.doc.scenes[0].dim).toBe(0.25);
  });
  it("rejects url asset, bad dim", () => {
    expect(errs(doc({ ...stock, asset: "http://x.com/a.mp4" })).length).toBe(1);
    expect(errs(doc({ ...stock, dim: 0.95 })).length).toBe(1);
  });
});

describe("pause_card", () => {
  it("accepts a valid card", () => expect(validateScenes(doc(pause)).ok).toBe(true));
  it("needs 2-4 options", () => {
    expect(errs(doc({ ...pause, options: ["A"], answer: 0 })).length).toBe(1);
    expect(errs(doc({ ...pause, options: ["A", "B", "C", "D", "E"] })).length).toBe(1);
  });
  it("answer must point at an option", () => expect(errs(doc({ ...pause, answer: 2 })).length).toBe(1));
  it("reveal must fall inside the scene", () => expect(errs(doc({ ...pause, revealAtMs: 4000 })).length).toBe(1));
});
