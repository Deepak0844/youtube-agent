import type { ChapterWindow } from "@/server/core/chapter-windows";
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

export function explainerBuildRequest(v: { topic: string; beats: PromptBeat[]; words: PromptWord[]; narrationS: number; style: string | null; format: "short"; orientation?: "portrait" | "landscape" }): { prompt: string; inputs: Record<string, string> } {
  const land = v.orientation === "landscape";
  const size = land ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
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
    `- Write one file, scene/video.tsx, with \`export const meta = { durationInFrames: ${frames}, fps: 30, width: ${size.width}, height: ${size.height} };\` and a default export. ${size.width} x ${size.height} ${land ? "landscape (16:9)" : "portrait"}.`,
    "- Time every beat to its seconds in input/script.json (frame = seconds x 30); bring each object in when its word is spoken. Captions are added by the app: leave the bottom 300 px free of important drawing.",
    "- Run check_code, then preview_frames with about one frame per beat (mid-beat). Look at every frame and fix what is wrong; preview again until every beat shows what its words say.",
    "- Frame 0 must already show the first beat's main object at full strength (do not fade or pop it in from nothing): the app's final render checks frames 0, middle and last and refuses an empty first frame, a black or blank frame, or a video where nothing moves.",
    "- Shape it as a Short (draw-objects section 5b): a hook at frame 0, a setup, a reveal in steps, a twist near the end that changes the picture, and a loop: the last frame matches frame 0 so the replay is seamless. No call to action at the end.",
    "- Show the idea, not a diagram of it (draw-objects section 5c): for an abstract topic draw an everyday picture people know, one picture per idea, a short label on each main object, the frame filled, and a story that reads with the sound off.",
    ...(land ? ["- This video is landscape: use draw-objects section 5d (landscape sizes) instead of the tall-frame numbers, and fill the wide frame."] : []),
    "- Last, run check_frames on scene/video.tsx and fix the file until it passes; only then finish.",
    "- When check_frames passes, read the suggest-sfx skill's engine section and write sfx-cues.json next to scene/ (light sound effects named by sound, timed to the frames you drew). Sound is never a reason to fail: if unsure, write {\"cues\":[]}.",
    "- Do not render the video: the app renders scene/video.tsx after you finish.",
    "",
    "Finish with one line per beat: its id and what is drawn in it.",
  ].join("\n");
  return { prompt, inputs };
}

/** The file the engine writes for chapter k of a long video: scene/ch01.tsx, scene/ch02.tsx, ... */
export const chapterSceneFile = (index: number): string => `scene/ch${String(index).padStart(2, "0")}.tsx`;
export const LOOK_FILE = "look-ch01.tsx";

/**
 * The build request for ONE chapter of a long video (L3). The chapter's beats and words are already on the chapter's own clock (they start at 0),
 * its frame count is exact, and it is one file of a longer video: no loop, no call to action, no twist of its own. Chapter 2 on get chapter 1's finished file
 * (input/look-ch01.tsx) to match the look. Pure.
 */
export function chapterBuildRequest(v: { topic: string; chapter: ChapterWindow; total: number; style: string | null; orientation: "portrait" | "landscape"; lookSource?: string }): { prompt: string; inputs: Record<string, string>; file: string } {
  const c = v.chapter;
  const land = v.orientation === "landscape";
  const size = land ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
  const durS = c.frames / 30;
  const playbook = playbookFor(v.style);
  const timed = beatTimings(c.beats, c.words, durS).map((b, i) => ({
    id: c.beats[i]!.id,
    text: c.beats[i]!.text,
    ...(c.beats[i]!.visual ? { visual: c.beats[i]!.visual } : {}),
    startS: round(b.realStartS ?? b.estStartS),
    endS: round(Math.min(b.realEndS ?? b.estEndS, durS)),
  }));
  const file = chapterSceneFile(c.index);
  const inputs: Record<string, string> = {
    "script.json": JSON.stringify({ topic: v.topic, chapter: { index: c.index, of: v.total, title: c.title, line: c.line }, narrationS: round(durS), beats: timed }, null, 2),
    "words.json": JSON.stringify(c.words),
    ...(v.lookSource ? { [LOOK_FILE]: v.lookSource } : {}),
  };
  const first = c.index === 1;
  const last = c.index === v.total;
  const prompt = [
    `Make chapter ${c.index} of ${v.total} ("${c.title}") of a long explainer video: "${v.topic}". The script is approved and narrated already. This is ONE chapter file; the app joins the chapters into one video.`,
    "",
    "Inputs (read-only): input/script.json (this chapter's beats with their text, the visual each asks for, and start and end seconds on THIS chapter's own clock) and input/words.json (every spoken word of this chapter with its start and end seconds, from 0).",
    ...(v.lookSource ? [`- input/${LOOK_FILE} is chapter 1 of this same video, already drawn and accepted. Match its colours, fonts, caption-safe zone and drawing style so the chapters look like one video. Do NOT copy its pictures: draw what THIS chapter's beats ask for.`] : []),
    "",
    "How:",
    "- Use the openmontage-pipeline skill for the craft (stages from scene planning on, pacing, review), the draw-objects skill to draw the objects, and vidtsx-2d-generator for the rules that keep a file from crashing.",
    "- This is a drawn Explainer (bespoke path): draw the things each beat talks about, any object it needs, as flat 2D art. Do not use the templated composition.",
    `- Style: ${playbook}. Colours and fonts from ref/openmontage/themes/${playbook}.json (pacing and motion from ref/openmontage/styles/${playbook}.yaml).`,
    `- Write one file, ${file}, with \`export const meta = { durationInFrames: ${c.frames}, fps: 30, width: ${size.width}, height: ${size.height} };\` and a default export. ${size.width} x ${size.height} ${land ? "landscape (16:9)" : "portrait"}. The file has EXACTLY ${c.frames} frames: they are this chapter's share of the whole video.`,
    "- Time every beat to its seconds in input/script.json (frame = seconds x 30); bring each object in when its word is spoken. Captions are added by the app: leave the bottom " + (land ? "220" : "300") + " px free of important drawing.",
    `- Run check_code on ${file}, then preview_frames with about one frame per beat (mid-beat). Look at every frame and fix what is wrong; preview again until every beat shows what its words say.`,
    `- Frame 0 must already show this chapter's first beat's main object at full strength (do not fade or pop it in from nothing): the app checks frames 0, middle and last of the chapter and refuses an empty first frame, a black or blank frame, or a chapter where nothing moves.`,
    first ? "- This is the FIRST chapter: open with a hook at frame 0 (the payoff or the surprising object, fully drawn). It sets the look every later chapter will match." : "- This chapter continues the video: start on a picture that follows naturally from the chapter before (no title card, no recap), and bring in the new idea within the first seconds.",
    last ? "- This is the LAST chapter: end on the payoff. No call to action ('like', 'subscribe', 'follow')." : "- End on a settled picture at a natural pause; the next chapter takes over. Do not loop back to frame 0 and do not add a call to action.",
    "- Show the idea, not a diagram of it (draw-objects section 5c): an everyday picture people know, one picture per idea, a short label on each main object, the frame filled, and a story that reads with the sound off." + (land ? " This chapter is landscape: use draw-objects section 5d." : ""),
    `- Last, run check_frames on ${file} and fix the file until it passes; only then finish.`,
    "- Do not write sfx-cues.json and do not render the video: the app renders this chapter after you finish.",
    "",
    "Finish with one line per beat: its id and what is drawn in it.",
  ].join("\n");
  return { prompt, inputs, file };
}
