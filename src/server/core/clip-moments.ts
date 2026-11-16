// Clip Factory CF1: pick short clip candidates from a long video's word times. Pure: no IO, no model call.
// A clip starts at the first word of a sentence and ends on the last word of one. A sentence ends at . ! ? or at a long silence, so a clip can start or end at a long pause inside a spoken sentence.
// Candidates never overlap. Each has a hook line (its first sentence), a score and a plain reason.

export interface MomentWord {
  word: string;
  startS: number;
  endS: number;
}
export interface Moment {
  /** cut start and end on the source timeline, in seconds (a little padding inside the gaps between words) */
  startS: number;
  endS: number;
  /** the first sentence of the clip: what the viewer hears first */
  hook: string;
  words: number;
  score: number;
  reason: string;
}
export interface MomentOpts {
  minS?: number;
  maxS?: number;
  /** how many clips at most */
  max?: number;
  /** a silence this long between two words also ends a sentence */
  gapS?: number;
}
export const MOMENT_DEFAULTS = { minS: 15, maxS: 90, max: 10, gapS: 1.2 } as const;
const SENTENCE_END = /[.!?।]["'”’)\]]*$/u;
const ABBREVIATION = /^(dr|mr|mrs|ms|prof|st|vs|etc|e\.g|i\.e|u\.s)\.$/i; // shortcut: English abbreviations only, add more when a language needs them
export const LEADS_BACK = /^(and|but|because|also|then|which|however)\b/i; // a joining word: the sentence needs the one before it
const HOOK_WORDS = /\b(why|how|what|never|nobody|secret|surprising|mistake|wrong|actually|imagine|here's|biggest|truth|stop)\b/i;
/** A sentence that starts less than this after the word before it is usually the middle of one spoken sentence that the transcript broke with a full stop. */
export const FLOW_PAUSE_S = 0.2;
const PAD_BEFORE_S = 0.15;
const PAD_AFTER_S = 0.25;
const MAX_WORDS = 20_000;

interface Sentence {
  firstWord: number; // index into words
  lastWord: number;
  text: string;
  startS: number;
  endS: number;
}

function splitSentences(words: readonly MomentWord[], gapS: number): Sentence[] {
  const out: Sentence[] = [];
  let from = 0;
  const close = (to: number) => {
    const slice = words.slice(from, to + 1);
    out.push({ firstWord: from, lastWord: to, text: slice.map((w) => w.word).join(" ").replace(/\s+/g, " ").trim(), startS: words[from]!.startS, endS: words[to]!.endS });
    from = to + 1;
  };
  for (let i = 0; i < words.length; i++) {
    const last = i === words.length - 1;
    if (last || (SENTENCE_END.test(words[i]!.word) && !ABBREVIATION.test(words[i]!.word)) || words[i + 1]!.startS - words[i]!.endS >= gapS) close(i);
  }
  return out;
}

/** 0 to 1: a hook is a short, direct first sentence, ideally a question or one that names a surprise. */
export function hookScore(s: Pick<Sentence, "text">, pauseBeforeS: number, afterQuestion = false): number {
  const n = s.text.split(/\s+/).length;
  let v = 0.3;
  if (n >= 4 && n <= 18) v += 0.3;
  if (/\?$/.test(s.text)) v += 0.2;
  if (HOOK_WORDS.test(s.text)) v += 0.15;
  if (/\d/.test(s.text)) v += 0.05;
  if (LEADS_BACK.test(s.text)) v -= 0.4; // starts mid-thought
  if (pauseBeforeS < FLOW_PAUSE_S) v -= 0.35; // starts with no pause: the speaker was still mid-sentence
  if (afterQuestion) v -= 0.25; // the sentence before asked something: this is its answer, and the question would be missing
  return Math.max(0, Math.min(1, v));
}

/** What the last word adds: a real full stop 0.1; a clip that ends on a question leaves it unanswered, -0.15. */
export function endingScore(lastWord: string): number {
  if (/\?["'\u201d\u2019)\]]*$/u.test(lastWord)) return -0.15;
  return SENTENCE_END.test(lastWord) ? 0.1 : 0;
}

/** 0 to 1: spoken pace between 2 and 3.5 words a second is good; long silences and rushed speech score lower. */
function paceScore(words: number, seconds: number): number {
  const wps = words / seconds;
  if (wps >= 2 && wps <= 3.5) return 1;
  return Math.max(0, 1 - Math.min(Math.abs(wps - 2.75) - 0.75, 2) / 2);
}

/** 0 to 1: clips near 45 s do best; the edges of the allowed range score lowest. */
function lengthScore(seconds: number, minS: number, maxS: number): number {
  const mid = Math.min(Math.max(45, minS), maxS);
  const span = Math.max(mid - minS, maxS - mid, 1);
  return 1 - Math.min(Math.abs(seconds - mid) / span, 1) * 0.6;
}

export function validateWords(words: readonly MomentWord[]): string | null {
  if (words.length === 0) return "There are no words, so there is nothing to cut.";
  if (words.length > MAX_WORDS) return `Too many words (${words.length}); the limit is ${MAX_WORDS}.`;
  let prevStart = -Infinity;
  for (const w of words) {
    if (typeof w.word !== "string" || !Number.isFinite(w.startS) || !Number.isFinite(w.endS) || w.startS < 0 || w.endS < w.startS) return "The word times are not valid numbers (a word ends before it starts, or a time is negative).";
    if (w.startS < prevStart) return "The word times are not in order.";
    prevStart = w.startS;
  }
  return null;
}

/** Clip candidates sorted by their start time, or a plain sentence saying why there are none. */
export function findMoments(words: readonly MomentWord[], opts: MomentOpts = {}): { ok: true; moments: Moment[] } | { ok: false; reason: string } {
  const minS = opts.minS ?? MOMENT_DEFAULTS.minS;
  const maxS = opts.maxS ?? MOMENT_DEFAULTS.maxS;
  const max = opts.max ?? MOMENT_DEFAULTS.max;
  const gapS = opts.gapS ?? MOMENT_DEFAULTS.gapS;
  if (!(minS > 0) || !(maxS >= minS) || !Number.isFinite(maxS) || maxS > 600 || !Number.isInteger(max) || max < 1) return { ok: false, reason: "The clip length limits or the clip count are not valid." };
  const bad = validateWords(words);
  if (bad) return { ok: false, reason: bad };

  const sentences = splitSentences(words, gapS);
  type Cand = Moment & { from: number; to: number };
  const cands: Cand[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const pauseBefore = sentences[i]!.firstWord > 0 ? sentences[i]!.startS - words[sentences[i]!.firstWord - 1]!.endS : Infinity;
    const afterQuestion = sentences[i]!.firstWord > 0 && /\?["'\u201d\u2019)\]]*$/u.test(words[sentences[i]!.firstWord - 1]!.word);
    const hook = hookScore(sentences[i]!, pauseBefore, afterQuestion);
    let best: Cand | undefined; // only the best window per start sentence is kept (keeps memory linear)
    for (let j = i; j < sentences.length; j++) {
      const dur = sentences[j]!.endS - sentences[i]!.startS;
      if (dur > maxS) break;
      if (dur < minS) continue;
      const nWords = sentences[j]!.lastWord - sentences[i]!.firstWord + 1;
      const pace = paceScore(nWords, dur);
      const len = lengthScore(dur, minS, maxS);
      const closes = endingScore(words[sentences[j]!.lastWord]!.word);
      const score = Math.round((hook * 0.45 + pace * 0.3 + len * 0.25 + closes) * 1000) / 1000;
      const prevEnd = sentences[i]!.firstWord > 0 ? words[sentences[i]!.firstWord - 1]!.endS : 0;
      const nextStart = sentences[j]!.lastWord < words.length - 1 ? words[sentences[j]!.lastWord + 1]!.startS : Infinity;
      // padding stays inside the silence next to the clip and never moves into its own first or last word (overlapping word times)
      const startS = Math.min(sentences[i]!.startS, Math.max(prevEnd + (sentences[i]!.startS - prevEnd) / 2, sentences[i]!.startS - PAD_BEFORE_S, 0));
      const endS = Math.max(sentences[j]!.endS, Math.min(sentences[j]!.endS + PAD_AFTER_S, sentences[j]!.endS + (nextStart - sentences[j]!.endS) / 2));
      if (endS - startS > maxS) continue;
      const parts: string[] = [];
      if (hook >= 0.7) parts.push("opens with a strong first sentence");
      else if (pauseBefore < FLOW_PAUSE_S) parts.push("opens mid-flow");
      else if (hook < 0.4) parts.push("opens mid-thought");
      if (pace >= 0.9) parts.push("steady pace");
      parts.push(`${Math.round(dur)} s`);
      const cand = { from: i, to: j, startS: Math.round(startS * 100) / 100, endS: Math.round(endS * 100) / 100, hook: sentences[i]!.text.slice(0, 160), words: nWords, score, reason: parts.join(", ") };
      if (!best || cand.score > best.score) best = cand;
    }
    if (best) cands.push(best);
  }
  if (cands.length === 0) return { ok: false, reason: `No run of whole sentences is between ${minS} and ${maxS} seconds long. The narration may have no sentence ends, or be too short.` };

  // Greedy: best score first, skipping anything that overlaps a clip already chosen.
  const chosen: Cand[] = [];
  for (const c of [...cands].sort((a, b) => b.score - a.score || a.from - b.from || a.to - b.to)) {
    if (chosen.length >= max) break;
    if (chosen.some((k) => c.from <= k.to && k.from <= c.to)) continue;
    chosen.push(c);
  }
  chosen.sort((a, b) => a.startS - b.startS);
  return { ok: true, moments: chosen.map((c) => ({ startS: c.startS, endS: c.endS, hook: c.hook, words: c.words, score: c.score, reason: c.reason })) };
}
