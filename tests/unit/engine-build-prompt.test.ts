import { describe, expect, it } from "vitest";
import { explainerBuildRequest } from "@/server/engine/build-prompt";

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
    for (const s of ["openmontage-pipeline", "draw-objects", "vidtsx-2d-generator", "scene/video.tsx", "check_code", "preview_frames", "input/script.json", "input/words.json", "ref/openmontage/themes/flat-motion-graphics.json"]) expect(prompt).toContain(s);
    expect(prompt).toContain("durationInFrames: 126"); // ceil(4.2 * 30)
    expect(prompt).toContain("1080");
    expect(prompt).toMatch(/do not render/i);
    expect(prompt).toContain("Why we need Docker");
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
