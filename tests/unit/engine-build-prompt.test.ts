import { describe, expect, it } from "vitest";
import { targetFrames } from "@/server/core/tsx-prompt";
import { chapterBuildRequest, chapterSceneFile, explainerBuildRequest } from "@/server/engine/build-prompt";

// OpenMontage parity, Phase D1: the engine's build request for a code-drawn Explainer, made from the approved script and the
// narration's word times. The script and word times travel as read-only input files; the prompt names the skills and the
// exact length.

const beats = [
  { id: "hook", text: "Your code works on your laptop.", visual: "a laptop with a green check" },
  { id: "fix", text: "Docker packs it into a container." },
];
const words = [
  { word: "Your", startS: 0.1, endS: 0.3 }, { word: "code", startS: 0.3, endS: 0.6 }, { word: "works", startS: 0.6, endS: 0.9 },
  { word: "Docker", startS: 2.4, endS: 2.8 }, { word: "packs", startS: 2.8, endS: 3.1 },
];

describe("explainerBuildRequest", () => {
  it("prompt_names_the_skills_and_the_exact_length", () => {
    const { prompt } = explainerBuildRequest({ topic: "Why we need Docker", beats, words, narrationS: 4.2, style: "flat-motion-graphics", format: "short" });
    for (const s of ["openmontage-pipeline", "draw-objects", "vidtsx-2d-generator", "scene/video.tsx", "check_code", "preview_frames", "check_frames", "Frame 0 must already show", "section 5b", "section 5c", "everyday picture", "twist", "the last frame matches frame 0", "input/script.json", "input/words.json", "ref/openmontage/themes/flat-motion-graphics.json"]) expect(prompt).toContain(s);
    expect(prompt).toContain(`durationInFrames: ${targetFrames(4.2)}`); // the narration plus the tail the code-scene step checks for
    expect(prompt).toContain("1080");
    expect(prompt).toMatch(/do not render/i);
    expect(prompt).toContain("Why we need Docker");
  });

  it("landscape_prompt_asks_for_a_1920x1080_meta_and_portrait_stays_the_same", () => {
    const base = { topic: "t", beats, words, narrationS: 4.2, style: null, format: "short" as const };
    expect(explainerBuildRequest(base).prompt).toContain("width: 1080, height: 1920 }");
    expect(explainerBuildRequest({ ...base, orientation: "portrait" }).prompt).toBe(explainerBuildRequest(base).prompt);
    const land = explainerBuildRequest({ ...base, orientation: "landscape" }).prompt;
    expect(land).toContain("width: 1920, height: 1080 }");
    expect(land).not.toContain("width: 1080, height: 1920");
    expect(land).toContain("section 5d");
    expect(explainerBuildRequest(base).prompt).not.toContain("5d");
  });

  it("inputs_carry_beats_and_words", () => {
    const { inputs } = explainerBuildRequest({ topic: "t", beats, words, narrationS: 4.2, style: null, format: "short" });
    expect(Object.keys(inputs).sort()).toEqual(["script.json", "words.json"]);
    const script = JSON.parse(inputs["script.json"]!) as { beats: Array<{ id: string; text: string; visual?: string; startS: number; endS: number }>; narrationS: number };
    expect(script.narrationS).toBe(4.2);
    expect(script.beats.map((b) => b.id)).toEqual(["hook", "fix"]);
    expect(script.beats[0]).toMatchObject({ text: beats[0]!.text, visual: "a laptop with a green check" });
    expect(script.beats[0]!.startS).toBeLessThan(script.beats[1]!.startS);
    expect(script.beats[1]!.endS).toBeLessThanOrEqual(4.2);
    expect(JSON.parse(inputs["words.json"]!)).toEqual(words);
  });

  it("style_falls_back_to_flat_motion_graphics_when_unset_or_unknown", () => {
    for (const style of [null, "made-up", "../x", "ai_studio"]) {
      expect(explainerBuildRequest({ topic: "t", beats, words, narrationS: 4.2, style, format: "short" }).prompt, String(style)).toContain("ref/openmontage/themes/flat-motion-graphics.json");
    }
    expect(explainerBuildRequest({ topic: "t", beats, words, narrationS: 4.2, style: "clean-professional", format: "short" }).prompt).toContain("ref/openmontage/themes/clean-professional.json");
  });
});

describe("chapterBuildRequest (long videos, L3)", () => {
  const chapter = (index: number) => ({
    index, title: `Chapter ${index} title`, line: "what the viewer learns", startS: (index - 1) * 30, endS: index * 30, startFrame: (index - 1) * 900, frames: 900,
    beats: [{ id: `c${index}_b1`, text: "Four words in here", visual: "a globe spins" }, { id: `c${index}_b2`, text: "and four more words", visual: "a phone lights up" }],
    words: [{ word: "Four", startS: 0, endS: 0.3 }, { word: "words", startS: 0.4, endS: 0.7 }, { word: "in", startS: 0.8, endS: 0.9 }, { word: "here", startS: 1, endS: 1.3 }, { word: "and", startS: 15, endS: 15.2 }, { word: "four", startS: 15.3, endS: 15.5 }, { word: "more", startS: 15.6, endS: 15.8 }, { word: "words", startS: 15.9, endS: 16.2 }],
  });
  const base = { topic: "DNS", total: 5, style: null, orientation: "landscape" as const };

  it("asks for ONE file named after the chapter with exactly the chapter's frames and the landscape size", () => {
    const r = chapterBuildRequest({ ...base, chapter: chapter(2) });
    expect(chapterSceneFile(2)).toBe("scene/ch02.tsx");
    expect(r.file).toBe("scene/ch02.tsx");
    expect(r.prompt).toContain("durationInFrames: 900, fps: 30, width: 1920, height: 1080");
    expect(r.prompt).toContain("EXACTLY 900 frames");
    expect(r.prompt).toContain("chapter 2 of 5");
    expect(r.prompt).toContain("section 5d");
    expect(chapterBuildRequest({ ...base, orientation: "portrait", chapter: chapter(2) }).prompt).toContain("width: 1080, height: 1920");
  });

  it("gives the beats and words on the chapter's own clock", () => {
    const r = chapterBuildRequest({ ...base, chapter: chapter(3) });
    const script = JSON.parse(r.inputs["script.json"]!) as { chapter: { index: number; of: number }; narrationS: number; beats: Array<{ id: string; startS: number; endS: number }> };
    expect(script.chapter).toMatchObject({ index: 3, of: 5 });
    expect(script.narrationS).toBe(30);
    expect(script.beats.map((b) => b.id)).toEqual(["c3_b1", "c3_b2"]);
    expect(script.beats[0]!.startS).toBe(0);
    expect(script.beats.at(-1)!.endS).toBeLessThanOrEqual(30);
    expect(JSON.parse(r.inputs["words.json"]!)).toHaveLength(8);
  });

  it("hands chapter 1's file to later chapters as the look, and only when given", () => {
    const withLook = chapterBuildRequest({ ...base, chapter: chapter(2), lookSource: "export default () => null; // chapter one" });
    expect(withLook.inputs["look-ch01.tsx"]).toContain("chapter one");
    expect(withLook.prompt).toContain("input/look-ch01.tsx");
    expect(withLook.prompt).toMatch(/Do NOT copy its pictures/);
    const none = chapterBuildRequest({ ...base, chapter: chapter(1) });
    expect(Object.keys(none.inputs).sort()).toEqual(["script.json", "words.json"]);
    expect(none.prompt).not.toContain("look-ch01");
  });

  it("a chapter is part of a longer video: no loop and no call to action, a hook only in chapter 1 and a payoff only in the last", () => {
    const first = chapterBuildRequest({ ...base, chapter: chapter(1) }).prompt;
    const mid = chapterBuildRequest({ ...base, chapter: chapter(3) }).prompt;
    const last = chapterBuildRequest({ ...base, chapter: chapter(5) }).prompt;
    for (const p of [first, mid, last]) expect(p).not.toMatch(/the last frame matches frame 0/);
    expect(first).toMatch(/FIRST chapter: open with a hook/);
    expect(mid).toMatch(/continues the video/);
    expect(mid).toMatch(/Do not loop back to frame 0/);
    expect(last).toMatch(/LAST chapter: end on the payoff/);
    expect(mid).toMatch(/Do not write sfx-cues\.json/); // sound is planned for the whole video, not per chapter
  });
});
