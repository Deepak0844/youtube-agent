// Props for the kit-video composition, shared by `npm run kit:video` and the render stage. Pure: no IO.
import type { CaptionWord } from "../../../remotion/kit/timeline";
import { validateScenes } from "./validate";
import type { SceneDoc } from "./schema";

export type VideoProps = { doc: SceneDoc; fps: number; audioSrc?: string; captions?: CaptionWord[]; assets?: Record<string, string> };

const MAX_CAPTION_WORDS = 10_000; // a 15-minute long video is about 2-3k words
const MAX_WORD_CHARS = 100;

function parseCaptions(text: string): { ok: true; words: CaptionWord[] } | { ok: false; error: string } {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `captions: not valid JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(j)) return { ok: false, error: "captions: must be a list of {word, startS, endS}" };
  if (j.length > MAX_CAPTION_WORDS) return { ok: false, error: `captions: at most ${MAX_CAPTION_WORDS} words, got ${j.length}` };
  const words: CaptionWord[] = [];
  for (const [i, w] of j.entries()) {
    if (typeof w?.word === "string" && w.word.length > MAX_WORD_CHARS) return { ok: false, error: `captions: word ${i + 1} is longer than ${MAX_WORD_CHARS} characters` };
    const ok = w && typeof w.word === "string" && w.word.trim() && Number.isFinite(w.startS) && Number.isFinite(w.endS) && w.startS >= 0 && w.endS >= w.startS;
    if (!ok) return { ok: false, error: `captions: word ${i + 1} needs word, startS and endS (seconds, end not before start)` };
    const estimated = w.estimated === true || w.source === "estimated" || w.flags?.includes?.("estimated") === true;
    words.push({ word: w.word, startS: w.startS, endS: w.endS, estimated });
  }
  return { ok: true, words };
}

/** Validate the scene file (and optional captions); on success, the props for the kit-video composition. */
export function buildVideoProps(
  sceneText: string,
  opts: { captionsText?: string; audioSrc?: string; fps: number; assets?: Record<string, string> },
): { ok: true; props: VideoProps } | { ok: false; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(sceneText);
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${(e as Error).message}`] };
  }
  const r = validateScenes(json);
  if (!r.ok) return r;
  const props: VideoProps = { doc: r.doc, fps: opts.fps };
  if (opts.audioSrc) props.audioSrc = opts.audioSrc;
  if (opts.assets) props.assets = opts.assets;
  if (opts.captionsText !== undefined) {
    const c = parseCaptions(opts.captionsText);
    if (!c.ok) return { ok: false, errors: [c.error] };
    props.captions = c.words;
  }
  return { ok: true, props };
}
