import { pageWords } from "../../../remotion/kit/presets";
import type { CaptionWord } from "../../../remotion/kit/timeline";

// Captions for custom-animation (tsx) videos. The model's scene draws no subtitles (the prompt says so), so the voice step burns
// them in from the real word times: an ASS file, 1-3 words per page, the spoken word in yellow, in the bottom safe zone
// (below y = 1497, which the scene keeps empty). Pure: no IO. Paging is the kit's own pageWords (same rules as punchy captions).

const PER_PAGE = 3;
const HOLD_S = 0.2; // the last word of a page stays a moment after it ends
const YELLOW = "&H5EE4FF&"; // #ffe45e in ASS (BGR) order

const clean = (w: string) => w.replace(/[{}\\\r\n]/g, "").replace(/\s+/g, " ").trim();
const stamp = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** The ASS subtitle text for a 1080x1920 video, or null when no usable word times exist. */
export function tsxCaptionsAss(input: readonly { word: string; startS: number; endS: number }[]): string | null {
  const words: CaptionWord[] = input
    .map((w) => ({ word: clean(String(w.word)), startS: Number(w.startS), endS: Number(w.endS) }))
    .filter((w) => w.word !== "" && Number.isFinite(w.startS) && Number.isFinite(w.endS) && w.startS >= 0 && w.endS >= w.startS);
  if (words.length === 0) return null;
  const pages = pageWords(words, PER_PAGE);
  const events: string[] = [];
  pages.forEach((page, pi) => {
    const nextPageStart = pages[pi + 1] ? words[pages[pi + 1]![0]!]!.startS : Infinity;
    page.forEach((wi, k) => {
      const w = words[wi]!;
      const end = k + 1 < page.length ? words[page[k + 1]!]!.startS : Math.min(w.endS + HOLD_S, nextPageStart);
      if (end <= w.startS) return;
      const text = page.map((j) => (j === wi ? `{\\c${YELLOW}}${words[j]!.word}{\\r}` : words[j]!.word)).join(" ");
      events.push(`Dialogue: 0,${stamp(w.startS)},${stamp(end)},Default,,0,0,0,,${text}`);
    });
  });
  return [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 0", "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Default,Inter,84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,60,60,150,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text", ...events, "",
  ].join("\n");
}
