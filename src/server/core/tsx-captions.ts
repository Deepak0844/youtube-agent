import type { CaptionWord } from "../../../remotion/kit/timeline";

// Captions for custom-animation (tsx) videos. The model's scene draws no subtitles; tsx-root.tsx draws them over the scene
// (remotion/kit/TsxCaptions.tsx) from the real word times, passed in meta.json. This file only cleans those word times and says,
// in plain words, whether captions will show. Pure: no IO. (An ffmpeg/libass burn-in was dropped: the host ffmpeg has no subtitles filter.)

const clean = (w: string) => w.replace(/[{}\\\r\n]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);

/** Usable caption words (non-empty text, finite ordered times), capped at 1500. */
export function tsxCaptionWords(input: readonly { word: string; startS: number; endS: number }[]): CaptionWord[] {
  return input
    .map((w) => ({ word: clean(String(w.word)), startS: Number(w.startS), endS: Number(w.endS) }))
    .filter((w) => w.word !== "" && Number.isFinite(w.startS) && Number.isFinite(w.endS) && w.startS >= 0 && w.endS >= w.startS)
    .slice(0, 1500);
}

/** "in_render" when captions were drawn into the picture, else "none (why)". */
export function tsxCaptionsStatus(words: readonly unknown[] | undefined): string {
  if (!words || words.length === 0) return "none (no word times were stored for this video)";
  return tsxCaptionWords(words as { word: string; startS: number; endS: number }[]).length > 0 ? "in_render" : "none (the stored word times are unusable)";
}
