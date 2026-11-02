// Pure helpers for the Preview tab: scene rows, look seeds, audio choice. No IO, no React.
import { LOOKS, pickLook } from "../../remotion/kit/look";
import { msToFrame } from "../../remotion/kit/timeline";
import type { SceneDoc } from "./scene";

export type SceneRow = { index: number; id: string; kind: string; startS: number; startLabel: string; startFrame: number; ok: boolean };

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One row per scene for the list: kind, start time, and a mark (ok = the scene passed the rule checks). */
export function sceneRows(doc: SceneDoc, failing: ReadonlySet<number>, fps: number): SceneRow[] {
  return doc.scenes.map((s, index) => ({
    index, id: s.id, kind: s.kind, startS: s.startMs / 1000, startLabel: fmtTime(s.startMs), startFrame: msToFrame(s.startMs, fps), ok: !failing.has(index),
  }));
}

export type AudioChoice = { src: string | null; source: "mix" | "narration" | "none"; note: string };

/** Full mix (the sound of final.mp4) first, then narration only, else silent with a note. */
export function pickAudio(a: { mixSrc?: string | null; narrationSrc?: string | null }): AudioChoice {
  if (a.mixSrc) return { src: a.mixSrc, source: "mix", note: "Sound: full mix (narration and effects)." };
  if (a.narrationSrc) return { src: a.narrationSrc, source: "narration", note: "Sound: narration only. The full mix is made after Render." };
  return { src: null, source: "none", note: "No sound yet, so scene timing is estimated." };
}

/** A seed that makes the kit pick palette number `i` (the kit only takes seeds). */
export function seedForLook(i: number): string {
  const want = LOOKS[((i % LOOKS.length) + LOOKS.length) % LOOKS.length];
  for (let n = 0; ; n++) {
    const seed = `look-${n}`;
    if (pickLook(seed) === want) return seed;
  }
}

/** What the Preview tab gets from the server (all JSON-safe). */
export interface PreviewData {
  doc: SceneDoc;
  fps: number;
  rows: SceneRow[];
  documentProblems: number;
  captions: Array<{ word: string; startS: number; endS: number; estimated?: boolean }> | null;
  assets: Record<string, string>;
  audio: AudioChoice;
}
