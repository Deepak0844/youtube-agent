import { describe, expect, it } from "vitest";
import { LOOKS, pickLook } from "../../remotion/kit/look";
import { fmtTime, pickAudio, sceneRows, seedForLook } from "@/shared/preview";
import { validateScenes, type SceneDoc } from "@/shared/scene";
import { kinds } from "@/shared/scene/kinds";
import { SAMPLE_SCENES, sampleDoc } from "@/shared/scene/samples";

const doc = { version: 1, scenes: [
  { id: "a", kind: "terminal", beat: "b1", startMs: 0, durationMs: 4000, lines: [] },
  { id: "b", kind: "chart", beat: "b2", startMs: 65_500, durationMs: 3000 },
] } as unknown as SceneDoc;

describe("preview helpers", () => {
  it("formats times as m:ss", () => {
    expect(fmtTime(0)).toBe("0:00");
    expect(fmtTime(65_500)).toBe("1:05");
    expect(fmtTime(-5)).toBe("0:00");
  });
  it("builds scene rows with start frame and check mark", () => {
    const rows = sceneRows(doc, new Set([1]), 30);
    expect(rows.map((r) => [r.kind, r.startLabel, r.startFrame, r.ok])).toEqual([["terminal", "0:00", 0, true], ["chart", "1:05", 1965, false]]);
  });
  it("prefers mix, then narration, then silence", () => {
    expect(pickAudio({ mixSrc: "m", narrationSrc: "n" })).toMatchObject({ src: "m", source: "mix" });
    expect(pickAudio({ mixSrc: null, narrationSrc: "n" })).toMatchObject({ src: "n", source: "narration" });
    const none = pickAudio({});
    expect(none).toMatchObject({ src: null, source: "none" });
    expect(none.note).toMatch(/estimated/);
  });
  it("finds a seed for every palette", () => {
    LOOKS.forEach((l, i) => expect(pickLook(seedForLook(i))).toBe(l));
  });
  it("has a valid sample for every scene kind", () => {
    expect(Object.keys(SAMPLE_SCENES).sort()).toEqual(Object.keys(kinds).sort());
    for (const k of Object.keys(kinds)) expect(validateScenes(sampleDoc(k)), k).toMatchObject({ ok: true });
  });
});
