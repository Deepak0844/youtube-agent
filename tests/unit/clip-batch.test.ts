import { describe, expect, it } from "vitest";
import { approveBatch, planBatch, reviewBatch, type BatchClip } from "@/server/core/clip-batch";
import type { Word } from "@/server/core/derive-short";

/** 3 words a second; each sentence is 12 words ("Point i ... .") with 0.4 s of silence after it. */
function talk(count: number): Word[] {
  const out: Word[] = [];
  let t = 0;
  for (let s = 0; s < count; s++) {
    for (let k = 0; k < 12; k++) { out.push({ word: k === 0 ? "Why" : k === 11 ? "end." : `w${k}`, startS: t, endS: t + 0.3 }); t += 1 / 3; }
    t += 0.4;
  }
  return out;
}
const source = talk(40); // about 175 s

describe("planBatch", () => {
  it("plans ids in time order with caption words shifted to start at 0 and inside the clip", () => {
    const r = planBatch(source);
    if (!r.ok) throw new Error(r.reason);
    expect(r.clips.length).toBeGreaterThanOrEqual(3);
    expect(r.clips.map((c) => c.id)).toEqual(r.clips.map((_, i) => `c${i + 1}`));
    for (const c of r.clips) {
      expect(c.words.length).toBeGreaterThan(10);
      expect(c.words[0]!.startS).toBeGreaterThanOrEqual(0);
      expect(c.words[0]!.startS).toBeLessThan(0.5); // the clip starts at its first word
      expect(c.words.at(-1)!.endS).toBeLessThanOrEqual(c.durationS + 0.01);
      expect(c.durationS).toBeCloseTo(c.endS - c.startS, 2);
    }
    for (let i = 1; i < r.clips.length; i++) expect(r.clips[i]!.startS).toBeGreaterThanOrEqual(r.clips[i - 1]!.endS);
  });
  it("passes the moment finder's plain refusals through", () => {
    expect(planBatch([])).toMatchObject({ ok: false, reason: expect.stringMatching(/no words/i) });
    expect(planBatch(talk(2))).toMatchObject({ ok: false });
  });
});

describe("reviewBatch", () => {
  const planned = (): BatchClip[] => {
    const r = planBatch(source, { max: 3 });
    if (!r.ok) throw new Error(r.reason);
    return r.clips;
  };
  it("passes a clip that is measured in range, and warns on one that is loud or unmeasured", () => {
    const clips = planned();
    const rev = reviewBatch(clips, { [clips[0]!.id]: { lufs: -16, truePeakDb: -3 }, [clips[1]!.id]: { lufs: -8, truePeakDb: -3 } }); // clips[2] has no measurement
    const loudness = (i: number) => rev.clips[i]!.checks.find((c) => c.id === "loudness")!;
    expect(loudness(0).ok).toBe(true);
    expect(loudness(1).warning).toMatch(/LUFS/);
    expect(loudness(2).warning).toMatch(/could not be measured/);
    expect(rev.clips.length).toBe(clips.length);
    expect(rev.needAttention).toBe(rev.clips.filter((c) => !c.ok).length);
    expect(rev.needAttention).toBeGreaterThanOrEqual(2);
  });
});

describe("approveBatch", () => {
  const review = () => {
    const r = planBatch(source, { max: 3 });
    if (!r.ok) throw new Error(r.reason);
    return reviewBatch(r.clips, {});
  };
  it("approves everything except the dropped clips, warnings included (the owner decides)", () => {
    const rev = review();
    expect(rev.needAttention).toBeGreaterThan(0);
    const ids = rev.clips.map((c) => c.id);
    expect(approveBatch(rev, [])).toEqual({ ok: true, approved: ids, dropped: [] });
    expect(approveBatch(rev, [ids[1]!])).toEqual({ ok: true, approved: [ids[0], ids[2]], dropped: [ids[1]] });
  });
  it("refuses a drop of a clip that is not in the batch and an approval that keeps nothing", () => {
    const rev = review();
    expect(approveBatch(rev, ["c99"])).toMatchObject({ ok: false, reason: expect.stringMatching(/batch changed/) });
    expect(approveBatch(rev, rev.clips.map((c) => c.id))).toMatchObject({ ok: false, reason: expect.stringMatching(/at least one clip/) });
  });
  it("a repeated drop id counts once", () => {
    const rev = review();
    const id = rev.clips[0]!.id;
    expect(approveBatch(rev, [id, id])).toMatchObject({ ok: true, dropped: [id] });
  });
});
