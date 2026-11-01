import { describe, expect, it } from "vitest";
import { LIMITS } from "@/shared/scene/kinds/common";
import { validateScenes } from "@/shared/scene";
import { retimeScenes } from "@/shared/scene/retime";

type S = Record<string, unknown>;
const term = (i: number, startMs: number, durationMs: number): S => ({ id: `s${i}`, beat: `b${i}`, kind: "terminal", startMs, durationMs, lines: [{ text: "ls" }] });
const mkDoc = (scenes: S[]) => {
  const v = validateScenes({ version: 1, scenes });
  if (!v.ok) throw new Error(v.errors.join(";"));
  return v.doc;
};
/** n words per beat, each 0.5 s long, back to back from 0. */
const words = (n: number) => Array.from({ length: n }, (_, i) => ({ word: `w${i}`, startS: i * 0.5, endS: i * 0.5 + 0.5 }));
const beats = (counts: number[]) => counts.map((c, i) => ({ id: `b${i + 1}`, text: Array.from({ length: c }, () => "x").join(" ") }));
const three = () => mkDoc([term(1, 0, 3000), term(2, 3000, 3000), term(3, 6000, 3000)]);

describe("retimeScenes", () => {
  it("splits at the real word boundaries of each beat", () => {
    const r = retimeScenes(three(), { words: words(12), beats: beats([2, 4, 6]), narrationDurationS: 6 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.scenes.map((s) => s.startMs)).toEqual([0, 1200, 3000]);
    expect(r.doc.scenes.map((s) => s.durationMs)).toEqual([1200, 1800, 3400]);
  });
  it("is contiguous, starts at 0, and the last scene reaches narration end plus tail", () => {
    const r = retimeScenes(three(), { words: words(12), beats: beats([4, 4, 4]), narrationDurationS: 6, tailMs: 500 });
    if (!r.ok) throw new Error(r.errors.join());
    let t = 0;
    for (const s of r.doc.scenes) { expect(s.startMs).toBe(t); t += s.durationMs; }
    expect(t).toBe(6500);
  });
  it("default tail is 400 ms", () => {
    const r = retimeScenes(three(), { words: words(12), beats: beats([4, 4, 4]), narrationDurationS: 6 });
    if (!r.ok) throw new Error();
    const last = r.doc.scenes.at(-1)!;
    expect(last.startMs + last.durationMs).toBe(6400);
  });
  it("keeps every scene at least the minimum", () => {
    const r = retimeScenes(three(), { words: words(12), beats: beats([1, 1, 10]), narrationDurationS: 6 });
    if (!r.ok) throw new Error(r.errors.join());
    for (const s of r.doc.scenes) expect(s.durationMs).toBeGreaterThanOrEqual(1200);
    const last = r.doc.scenes.at(-1)!;
    expect(last.startMs + last.durationMs).toBe(6400);
  });
  it("falls back to proportional scaling when words do not match the beats", () => {
    const r = retimeScenes(three(), { words: words(40), beats: beats([2, 2, 2]), narrationDurationS: 18 });
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.doc.scenes.map((s) => s.durationMs)).toEqual([6133, 6134, 6133]);
  });
  it("falls back when a scene's beat is not in the beats list", () => {
    const r = retimeScenes(three(), { words: words(6), beats: beats([3, 3]), narrationDurationS: 5 });
    if (!r.ok) throw new Error(r.errors.join());
    const last = r.doc.scenes.at(-1)!;
    expect(last.startMs + last.durationMs).toBe(5400);
  });
  it("errors instead of truncating when the narration cannot fit the caps", () => {
    const r = retimeScenes(three(), { words: words(12), beats: beats([4, 4, 4]), narrationDurationS: 200 });
    expect(r.ok).toBe(false);
    const big = retimeScenes(three(), { words: words(12), beats: beats([1, 1, 10]), narrationDurationS: LIMITS.maxSceneMs / 1000 + 5 });
    expect(big.ok).toBe(false);
  });
  it("scales kind-internal ms fields and stays valid", () => {
    const pause: S = { id: "s1", beat: "b1", kind: "pause_card", startMs: 0, durationMs: 4000, question: "Q?", options: ["a", "b"], answer: 0, revealAtMs: 2000 };
    const algo: S = { id: "s2", beat: "b2", kind: "algo_cells", startMs: 4000, durationMs: 4000, cells: ["3", "1"], steps: [{ at: 1000, type: "compare", i: 0, j: 1 }, { at: 3000, type: "swap", i: 0, j: 1 }] };
    const piano: S = { id: "s3", beat: "b3", kind: "piano", startMs: 8000, durationMs: 4000, events: [{ atMs: 0, notes: ["C4"] }, { atMs: 2000, notes: ["E4"] }] };
    const r = retimeScenes(mkDoc([pause, algo, piano]), { words: words(12), beats: beats([2, 4, 6]), narrationDurationS: 6 });
    if (!r.ok) throw new Error(r.errors.join());
    const [p, a, pi] = r.doc.scenes as unknown as Array<{ durationMs: number; revealAtMs: number; steps: Array<{ at: number }>; events: Array<{ atMs: number }> }>;
    expect(p!.durationMs).toBe(1200);
    expect(p!.revealAtMs).toBe(600);
    expect(a!.durationMs).toBe(1800);
    expect(a!.steps.map((s) => s.at)).toEqual([450, 1350]);
    expect(pi!.events.map((e) => e.atMs)).toEqual([0, 1700]);
  });
  it("does not mutate the input", () => {
    const d = three();
    const before = JSON.stringify(d);
    retimeScenes(d, { words: words(12), beats: beats([2, 4, 6]), narrationDurationS: 6 });
    expect(JSON.stringify(d)).toBe(before);
  });
});
