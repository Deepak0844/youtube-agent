// Pure: which free picture best shows what a beat's visual brief describes. No IO. A candidate that is too small, the wrong
// shape or format, or a stranger's portrait is rejected (null); the rest get a score in about 0..1.2 and the best one is
// taken only when it reaches MIN_SCORE, so a weak match means "no picture" rather than an unrelated one.

export interface PictureCandidate {
  source: "wikimedia" | "pixabay";
  title: string;
  /** What is downloaded (a 1280 px rendition for big originals). */
  url: string;
  /** Size of the ORIGINAL file; used for the quality checks. */
  width: number;
  height: number;
  mime: string;
  licence: string;
  credit: string;
  /** https page on an allowed host, or null when the source gave none/a bad one. */
  pageUrl: string | null;
  /** Description, categories or tags, plain text. */
  text: string;
}
export interface PictureBrief { search: readonly string[]; visual: string }

export const MIN_LONG_SIDE = 1000;
/** Too thin a picture looks soft once fitted into the frame. */
export const MIN_SHORT_SIDE = 640;
/** Below this long side the picture is upscaled on screen and looks soft: it ranks lower (no pixel analysis, size only). */
export const SHARP_LONG_SIDE = 1400;
export const SOFT_PENALTY = 0.12;
export const MIN_ASPECT = 0.4;
export const MAX_ASPECT = 2.5;
export const MIN_SCORE = 0.35;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "showing", "shows", "show", "view", "picture", "photo", "image", "close", "into", "over", "its", "are", "type", "kind"]);
const DIAGRAMISH = /\b(diagram|cutaway|cut-away|schematic|exploded|infographic|illustration|chart|blueprint|section)s?\b/i;
const PORTRAITISH = /\b(portrait|headshot|mugshot|selfie)s?\b/i;
const PERSON_WORDS = /\b(portrait|person|people|man|woman|men|women|girl|boy|child|children|baby|face|couple|family|crowd|model|scientist|inventor|president|king|queen|emperor|author|actor|singer|athlete)\b/i;
// Pixabay tags that mean a person is the subject (a stranger's likeness): refused unless the brief is about people.
const PERSON_TAGS = /\b(woman|man|girl|boy|people|person|child|children|baby|face|portrait|model|couple|family|crowd)\b/i;

const stem = (w: string) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);
export function words(s: string): string[] {
  return [...new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem))];
}

/** A brief names a person only when it says so with a person word (two capitalised words such as "Golden Gate" do not count). */
function namesPerson(brief: PictureBrief): boolean {
  return PERSON_WORDS.test([brief.visual, ...brief.search].join(" . "));
}

export function scoreCandidate(brief: PictureBrief, c: PictureCandidate): number | null {
  const long = Math.max(c.width, c.height);
  const aspect = c.height > 0 ? c.width / c.height : 0;
  if (!(long >= MIN_LONG_SIDE) || Math.min(c.width, c.height) < MIN_SHORT_SIDE || aspect < MIN_ASPECT || aspect > MAX_ASPECT) return null;
  if (!ALLOWED_MIME.has(c.mime.toLowerCase())) return null;
  if ((PORTRAITISH.test(c.title) || (c.source === "pixabay" && PERSON_TAGS.test(c.text))) && !namesPerson(brief)) return null;

  const want = words([...brief.search, brief.visual].join(" "));
  if (want.length === 0) return null;
  const title = new Set(words(c.title));
  const text = new Set(words(c.text));
  let sum = 0;
  for (const w of want) sum += title.has(w) ? 2 : text.has(w) ? 1 : 0;
  let score = sum / (2 * want.length);
  if (score === 0) return 0;
  if (DIAGRAMISH.test(brief.visual) && DIAGRAMISH.test(`${c.title} ${c.text}`)) score += 0.15;
  if (long < SHARP_LONG_SIDE) score -= SOFT_PENALTY;
  if (c.height >= c.width) score += 0.05;
  else if (c.width >= 1600) score += 0.05;
  return score;
}

/** Acceptable candidates at or above MIN_SCORE, best first; equal scores keep input order. */
export function rankCandidates(brief: PictureBrief, cands: readonly PictureCandidate[]): Array<{ cand: PictureCandidate; score: number }> {
  const out: Array<{ cand: PictureCandidate; score: number }> = [];
  for (const cand of cands) {
    const score = scoreCandidate(brief, cand);
    if (score !== null && score >= MIN_SCORE) out.push({ cand, score });
  }
  return out.sort((a, b) => b.score - a.score); // Array.sort is stable
}

/** The best one, or null. */
export function pickBest(brief: PictureBrief, cands: readonly PictureCandidate[]): { cand: PictureCandidate; score: number } | null {
  return rankCandidates(brief, cands)[0] ?? null;
}
