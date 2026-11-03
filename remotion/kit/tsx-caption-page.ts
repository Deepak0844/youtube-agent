import { pageWords } from "./presets";
import type { CaptionWord } from "./timeline";

// Pure paging for the always-on caption overlay of a TSX video (same rules as the punchy captions: pageWords, 1-3 words a page,
// the spoken word highlighted). No React, no IO.
export const PER_PAGE = 3;
export const HOLD_S = 0.2; // the last word of a page stays a moment after it ends

/** The page showing at time `t` (seconds) and which of its words is active, or null between pages. */
export function captionAt(words: readonly CaptionWord[], t: number): { words: string[]; active: number } | null {
  const pages = pageWords(words, PER_PAGE);
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi]!;
    const first = words[page[0]!]!;
    const last = words[page[page.length - 1]!]!;
    const nextStart = pages[pi + 1] ? words[pages[pi + 1]![0]!]!.startS : Infinity;
    if (t < first.startS) return null;
    if (t >= Math.min(last.endS + HOLD_S, nextStart)) continue;
    let active = 0;
    page.forEach((wi, k) => { if (t >= words[wi]!.startS) active = k; });
    return { words: page.map((i) => words[i]!.word), active };
  }
  return null;
}
