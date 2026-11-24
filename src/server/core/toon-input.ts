import type { ToonCharacter, ToonInput } from "../../../remotion/kit/toon/context";
import type { CartoonStyleId } from "../../../remotion/kit/toon/styles";
import { beatTimings, type PromptBeat, type PromptWord } from "@/server/core/tsx-prompt";

// What a cartoon scene draws from (the ToonInput): the beats of the CURRENT narration (so re-voicing moves the visuals and the scene file is
// not touched), the series cast, and the frame shape. For a chapter of a long video, pass that chapter's beats and words: they are already on
// the chapter's own clock, so B0 is the chapter's first beat. Pure.

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The caption text of a beat: the narration with the words that carry the point marked *like this* (numbers, money, percentages, SHOUTED words). */
export function highlightCaption(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  let marked = 0;
  return words
    .map((w) => {
      const core = w.replace(/^[^\p{L}\p{N}₹$€£%]+|[^\p{L}\p{N}₹$€£%]+$/gu, "");
      const strong = /\d|[₹$€£%]/.test(core) || (core.length >= 3 && core === core.toUpperCase() && /\p{L}/u.test(core));
      if (!strong || marked >= 3) return w.replace(/\*/g, "");
      marked += 1;
      return `*${w.replace(/\*/g, "")}*`;
    })
    .join(" ");
}

export function toonInputFor(a: { beats: readonly PromptBeat[]; words: readonly PromptWord[]; durationS: number; orientation: "portrait" | "landscape"; cast: ToonCharacter[]; style?: CartoonStyleId }): ToonInput {
  const timed = beatTimings(a.beats, a.words, a.durationS);
  return {
    timeline: {
      beats: timed.map((b, i) => ({
        startS: round(b.realStartS ?? b.estStartS),
        endS: round(Math.min(b.realEndS ?? b.estEndS, a.durationS)),
        cap: a.beats[i]!.text.trim() ? highlightCaption(a.beats[i]!.text) : null,
      })),
      scenes: [], // the scene file's own <ToonFilm scenes=...> says when each scene is on
    },
    cast: a.cast,
    orientation: a.orientation,
    ...(a.style ? { style: a.style } : {}),
  };
}
