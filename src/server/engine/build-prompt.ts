import { beatTimings, targetFrames, type PromptBeat, type PromptWord } from "@/server/core/tsx-prompt";
import { omThemeConfig } from "@/server/engine/om-checks/theme";

// OpenMontage parity, Phase D1: the engine build request for a code-drawn Explainer (owner decision 2026-11-14, "Way 2"):
// the approved script with each beat's times and the narration's word times go in as read-only input files; the prompt tells
// Claude which skills to use, the exact length and size, and to check and preview but never render (the step renders).

/** The app's Looks that match an OpenMontage style playbook; any other Look draws in flat-motion-graphics. */
const LOOK_TO_PLAYBOOK: Readonly<Record<string, string>> = {
  clean_professional: "clean-professional",
  flat_motion: "flat-motion-graphics",
  minimal_diagram: "minimalist-diagram",
  premium_editorial: "premium-minimalist",
};
const FALLBACK = "flat-motion-graphics";

/** The OpenMontage playbook for a video's style: a Look id, or a playbook name, or the fallback. */
export function playbookFor(style: string | null | undefined): string {
  if (!style) return FALLBACK;
  const name = Object.hasOwn(LOOK_TO_PLAYBOOK, style) ? LOOK_TO_PLAYBOOK[style]! : style;
  return omThemeConfig(name) ? name : FALLBACK;
}

const round = (n: number) => Math.round(n * 100) / 100;

export function explainerBuildRequest(v: { topic: string; beats: PromptBeat[]; words: PromptWord[]; narrationS: number; style: string | null; format: "short" }): { prompt: string; inputs: Record<string, string> } {
  const frames = targetFrames(v.narrationS); // the narration plus a short tail: exactly what the code-scene step checks
  const playbook = playbookFor(v.style);
  const timed = beatTimings(v.beats, v.words, v.narrationS).map((b, i) => ({
    id: v.beats[i]!.id,
    text: v.beats[i]!.text,
    ...(v.beats[i]!.visual ? { visual: v.beats[i]!.visual } : {}),
    startS: round(b.realStartS ?? b.estStartS),
    endS: round(Math.min(b.realEndS ?? b.estEndS, v.narrationS)),
  }));
  const inputs = {
    "script.json": JSON.stringify({ topic: v.topic, narrationS: v.narrationS, beats: timed }, null, 2),
    "words.json": JSON.stringify(v.words),
  };
  const prompt = [
    `Make the video for this Explainer Short: "${v.topic}". The script is approved and narrated already.`,
    "",
    "Inputs (read-only): input/script.json (each beat's text, the visual it asks for, its start and end seconds) and input/words.json (every spoken word's start and end seconds).",
    "",
    "How:",
    "- Use the openmontage-pipeline skill for the craft (stages from scene planning on, pacing, review), the draw-objects skill to draw the objects, and vidtsx-2d-generator for the rules that keep a file from crashing.",
    "- This is a drawn Explainer (bespoke path): draw the things each beat talks about, any object it needs, as flat 2D art. Do not use the templated composition.",
    `- Style: ${playbook}. Colours and fonts from ref/openmontage/themes/${playbook}.json (pacing and motion from ref/openmontage/styles/${playbook}.yaml).`,
    `- Write one file, scene/video.tsx, with \`export const meta = { durationInFrames: ${frames}, fps: 30, width: 1080, height: 1920 };\` and a default export. 1080 x 1920 portrait.`,
    "- Time every beat to its seconds in input/script.json (frame = seconds x 30); bring each object in when its word is spoken. Captions are added by the app: leave the bottom 300 px free of important drawing.",
    "- Run check_code, then preview_frames with about one frame per beat (mid-beat). Look at every frame and fix what is wrong; preview again until every beat shows what its words say.",
    "- Do not render the video: the app renders scene/video.tsx after you finish.",
    "",
    "Finish with one line per beat: its id and what is drawn in it.",
  ].join("\n");
  return { prompt, inputs };
}
