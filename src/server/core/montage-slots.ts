import type { FootageSlot } from "./montage-footage";
import { beatTimings, type PromptBeat, type PromptWord } from "./tsx-prompt";
import { words as wordsOf } from "./picture-rank";

// Montage M3 (pure, no IO): turns the script's beats and the narration's word times into the slots the footage picker fills.
// One slot per beat, as long as that beat is spoken; a beat shorter than MIN_SLOT_S is folded into the slot before it (a 1 s clip is a flash, not a shot).
// The slot seconds add up to the narration exactly, so the film is as long as the voice.

export const MIN_SLOT_S = 2;
export type MontageBeat = PromptBeat & { /** words the script suggested to search for */ search?: readonly string[] };

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function montageSlots(beats: readonly MontageBeat[], words: readonly PromptWord[], narrationS: number): FootageSlot[] {
  if (beats.length === 0 || !(narrationS > 0)) return [];
  const timed = beatTimings(beats, words, narrationS);
  const out: FootageSlot[] = [];
  timed.forEach((t, i) => {
    const start = t.realStartS ?? t.estStartS;
    const end = t.realEndS ?? t.estEndS;
    const seconds = end - start;
    const prev = out[out.length - 1];
    if (prev && seconds < MIN_SLOT_S) { prev.seconds += seconds; return; }
    const query = wordsOf([...(beats[i]!.search ?? []), beats[i]!.visual ?? "", ...((beats[i]!.search?.length ?? 0) > 0 || beats[i]!.visual ? [] : [t.text])].join(" "));
    out.push({ id: t.id, query: [...new Set(query)], seconds });
  });
  if (out.length === 0) return [];
  for (const s of out) s.seconds = r3(s.seconds);
  const sum = out.reduce((a, s) => a + s.seconds, 0);
  out[out.length - 1]!.seconds = r3(out[out.length - 1]!.seconds + (narrationS - sum)); // the rounding left-over goes to the last shot
  return out;
}
