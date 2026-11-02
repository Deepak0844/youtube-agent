import { MIN_SCORE, namesPerson, PERSON_TAGS, words, type PictureBrief } from "./picture-rank";

// Pure: which free stock clip best shows a beat that describes motion. No IO. Same word-match scoring as pictures; a clip of
// the wrong length or size, or a stranger's face, is rejected (null). A weak match means "no clip" (the beat keeps a photo).

export interface ClipCandidate {
  title: string;
  /** The chosen rendition's file (https, allow-listed host). */
  url: string;
  width: number;
  height: number;
  durationS: number;
  /** Size the source reports for the chosen rendition. */
  bytes: number;
  licence: string;
  credit: string;
  pageUrl: string | null;
  /** Tags, plain text. */
  text: string;
}

export const CLIP_MIN_SECONDS = 5;
export const CLIP_MAX_SECONDS = 20;
export const CLIP_MAX_BYTES = 25 * 1024 * 1024;
export const CLIP_MIN_HEIGHT = 720;
/** At most this many clips in one video, and at most this many downloaded bytes of clips per pictures run. */
export const MAX_CLIPS_PER_VIDEO = 3;
export const CLIPS_TOTAL_MAX_BYTES = 60 * 1024 * 1024;

// A visual brief that describes something moving or a real-world scene, not a still object or a diagram.
const MOTION = /\b(flow(?:s|ing)?|mov(?:e|es|ing)|spin(?:s|ning)?|rotat\w+|driv(?:e|es|ing)|fly(?:ing)?|flies|flight|wave|waves|ocean|sea|river|waterfall|rain|storm|lightning|fire|flame|burn\w*|smoke|explo\w+|run(?:s|ning)?|walk\w*|fall(?:s|ing)?|grow(?:s|ing)?|bloom\w*|traffic|crowd|train|car|cars|plane|rocket|launch\w*|clouds?|time-?lapse|aerial|drone|spray\w*|pour\w*|bubbl\w+|swirl\w*|machine|factory|assembly|footage|clip)\b/i;
const DIAGRAM = /\b(diagram|chart|graph|schematic|infographic|table|equation|screenshot|logo|map)s?\b/i;

/** True when the beat's visual describes real motion. A diagram-like brief never gets a clip. */
export function wantsMotion(visual: string): boolean {
  return MOTION.test(visual) && !DIAGRAM.test(visual);
}

export function scoreClip(brief: PictureBrief, c: ClipCandidate): number | null {
  if (!(c.durationS >= CLIP_MIN_SECONDS && c.durationS <= CLIP_MAX_SECONDS)) return null;
  if (!(c.bytes > 0 && c.bytes <= CLIP_MAX_BYTES) || !(c.height >= CLIP_MIN_HEIGHT) || !(c.width > 0)) return null;
  if (PERSON_TAGS.test(c.text) && !namesPerson(brief)) return null;
  const want = words([...brief.search, brief.visual].join(" "));
  if (want.length === 0) return null;
  const title = new Set(words(c.title));
  const text = new Set(words(c.text));
  let sum = 0;
  for (const w of want) sum += title.has(w) ? 2 : text.has(w) ? 1 : 0;
  return sum / (2 * want.length);
}

/** Acceptable clips at or above MIN_SCORE, best first; equal scores keep input order. */
export function rankClips(brief: PictureBrief, cands: readonly ClipCandidate[]): Array<{ cand: ClipCandidate; score: number }> {
  const out: Array<{ cand: ClipCandidate; score: number }> = [];
  for (const cand of cands) {
    const score = scoreClip(brief, cand);
    if (score !== null && score >= MIN_SCORE) out.push({ cand, score });
  }
  return out.sort((a, b) => b.score - a.score);
}
