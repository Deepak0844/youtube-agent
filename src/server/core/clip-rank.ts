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
export const MONTAGE_CLIP_MAX_SECONDS = 60;
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

/** `maxS`: the longest clip taken (default CLIP_MAX_SECONDS). A montage trims its clips from the middle, so it takes longer ones (MONTAGE_CLIP_MAX_SECONDS). */
export function scoreClip(brief: PictureBrief, c: ClipCandidate, maxS = CLIP_MAX_SECONDS): number | null {
  if (!(c.durationS >= CLIP_MIN_SECONDS && c.durationS <= maxS)) return null;
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
export function rankClips(brief: PictureBrief, cands: readonly ClipCandidate[], maxS = CLIP_MAX_SECONDS): Array<{ cand: ClipCandidate; score: number }> {
  const out: Array<{ cand: ClipCandidate; score: number }> = [];
  for (const cand of cands) {
    const score = scoreClip(brief, cand, maxS);
    if (score !== null && score >= MIN_SCORE) out.push({ cand, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Largest clip download still allowed in this run, or 0 when less than a whole clip's worth of budget is left. */
export function clipBudget(bytesSoFar: number): number {
  const room = Math.min(CLIP_MAX_BYTES, CLIPS_TOTAL_MAX_BYTES - bytesSoFar);
  return room >= CLIP_MAX_BYTES ? room : 0;
}

/** Clip links already on the video's live beats (every beat, whatever its brief), so the per-video limit holds. */
export function countClipLinks(links: ReadonlyArray<{ beatId: string; kind?: string }>, liveBeats: ReadonlySet<string>): number {
  return links.filter((l) => l.kind === "video" && liveBeats.has(l.beatId)).length;
}

/**
 * Montage: a beat's search phrases are ALTERNATIVES ("night train window" or "dark countryside train"), not one long wish, so each clip is scored against the
 * phrase it was found by and keeps its best score. (Scored against every word of every phrase plus the beat's long picture sentence, no clip could reach MIN_SCORE:
 * the first real run found no footage for any beat.) Best first; a clip found by two phrases counts once.
 */
export function rankClipsByPhrase(found: ReadonlyArray<{ phrase: string; cands: readonly ClipCandidate[] }>, maxS = MONTAGE_CLIP_MAX_SECONDS): Array<{ cand: ClipCandidate; score: number }> {
  const best = new Map<string, { cand: ClipCandidate; score: number }>();
  for (const { phrase, cands } of found) {
    const subject = subjectWords(phrase);
    for (const r of rankClips({ search: [phrase], visual: "" }, cands, maxS)) {
      if (!showsSubject(subject, r.cand) || SYNTHETIC.test(`${r.cand.title} ${r.cand.text}`)) continue;
      const old = best.get(r.cand.url);
      if (!old || r.score > old.score) best.set(r.cand.url, r);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

// A montage is real footage: drawn, animated or AI-made clips are skipped.
const SYNTHETIC = /\b(ai[- ]generated|ai art|anime|cartoon|animation|animated|illustration|3d|cgi|rendered|render|lofi|digital art|midjourney)\b/i;

// Words that colour a shot but are not what it shows. A clip tagged only "night, moon, dark" matches "night train window" on them and shows no train.
const MODIFIERS = new Set(["night", "dark", "dim", "light", "lights", "evening", "dawn", "dusk", "sunset", "sunrise", "morning", "empty", "quiet", "lonely", "blurred", "blur", "slow", "old", "cozy", "moody", "calm", "misty", "foggy", "lit", "late", "deep", "bright", "soft", "gentle", "wide", "close", "shot", "view", "footage", "video", "scene", "background", "dramatic", "beautiful", "aerial"]);

/** What a search phrase is about: its words without the mood and light words. */
export function subjectWords(phrase: string): string[] {
  return words(phrase).filter((w) => !MODIFIERS.has(w));
}

/** A clip must show the phrase's main subject: its first word that is not a mood or light word ("train" in "night train window", "sleeper" in "dark sleeper cabin"). Phrases are written topic first. No subject words (all mood) = no rule. */
export function showsSubject(subject: readonly string[], c: Pick<ClipCandidate, "title" | "text">): boolean {
  if (subject.length === 0) return true;
  return new Set(words(`${c.title} ${c.text}`)).has(subject[0]!);
}
