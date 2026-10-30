// Pure parts of `npm run kit:video`: arguments and props. Tested in tests/unit/kit-video.test.ts.
import { validateScenes, type SceneDoc } from "../src/shared/scene";
import type { CaptionWord } from "../remotion/kit/timeline";

export type VideoArgs = { file: string; audio?: string; captions?: string };

export function parseVideoArgs(argv: string[]): VideoArgs | { error: string } {
  const usage = { error: "usage: npm run kit:video -- <scenes.json> [--audio file.wav] [--captions captions.json]" };
  const a = argv.filter((x) => x !== "--");
  const out: Partial<VideoArgs> = {};
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    if (x === "--audio" || x === "--captions") {
      const v = a[++i];
      if (!v || v.startsWith("-")) return usage;
      out[x === "--audio" ? "audio" : "captions"] = v;
    } else if (x.startsWith("-") || out.file) return usage;
    else out.file = x;
  }
  return out.file ? (out as VideoArgs) : usage;
}

function parseCaptions(text: string): { ok: true; words: CaptionWord[] } | { ok: false; error: string } {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `captions: not valid JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(j)) return { ok: false, error: "captions: must be a list of {word, startS, endS}" };
  const words: CaptionWord[] = [];
  for (const [i, w] of j.entries()) {
    const ok = w && typeof w.word === "string" && w.word.trim() && Number.isFinite(w.startS) && Number.isFinite(w.endS) && w.startS >= 0 && w.endS >= w.startS;
    if (!ok) return { ok: false, error: `captions: word ${i + 1} needs word, startS and endS (seconds, end not before start)` };
    words.push({ word: w.word, startS: w.startS, endS: w.endS, estimated: w.estimated === true || w.flags?.includes?.("estimated") === true });
  }
  return { ok: true, words };
}

/** Validate the scene file (and optional captions); on success, the props for the kit-video composition. */
export function buildVideoProps(
  sceneText: string,
  opts: { captionsText?: string; audioSrc?: string; fps: number },
): { ok: true; props: { doc: SceneDoc; fps: number; audioSrc?: string; captions?: CaptionWord[] } } | { ok: false; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(sceneText);
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${(e as Error).message}`] };
  }
  const r = validateScenes(json);
  if (!r.ok) return r;
  const props: { doc: SceneDoc; fps: number; audioSrc?: string; captions?: CaptionWord[] } = { doc: r.doc, fps: opts.fps };
  if (opts.audioSrc) props.audioSrc = opts.audioSrc;
  if (opts.captionsText !== undefined) {
    const c = parseCaptions(opts.captionsText);
    if (!c.ok) return { ok: false, errors: [c.error] };
    props.captions = c.words;
  }
  return { ok: true, props };
}
