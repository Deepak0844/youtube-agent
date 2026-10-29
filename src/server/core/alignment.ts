import type { Lang } from "@/server/core/lang";

// Doc 9 1 / ADR 0008: put whisper's word times onto the SCRIPT's words. Pure: no IO.
// The script's spelling always wins (whisper's spelling is never used for captions). Anything that looks unsure is flagged
// for a human check; estimated timings are always "approximate" so they can never look exact.

export type AlignFlag = "low_confidence" | "too_short" | "too_long" | "loop" | "count_mismatch" | "language_unreliable" | "interpolated";
export type TimingsKind = "native" | "aligned" | "estimated";
export interface Recognised { word: string; startS: number; endS: number; p: number }
export interface CaptionWord { word: string; startS: number; endS: number; source: "recognised" | "interpolated" | "estimated"; flags: AlignFlag[] }
export interface MapResult { words: CaptionWord[]; stats: { scriptWords: number; recognisedWords: number; matched: number } }
export interface CaptionsBody { timings_kind: TimingsKind; words: CaptionWord[]; needs_check: boolean; flags: AlignFlag[]; approximate: boolean }

export const LOW_P = 0.5;
export const MIN_WORD_S = 0.05;
export const MAX_WORD_S = 2;
export const MAX_COUNT_DRIFT = 0.15;
export const MAX_CHUNK_S = 30;
export const UNRELIABLE_LANGS: readonly Lang[] = ["te", "kn", "ml"];

const norm = (s: string): string => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");

function lev(a: string, b: string): number {
  const p = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = p[0]!;
    p[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = p[j]!;
      p[j] = Math.min(p[j]! + 1, p[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return p[b.length]!;
}
const subCost = (a: string, b: string): number => {
  const x = norm(a), y = norm(b);
  return (lev(x, y) / Math.max(x.length, y.length, 1)) * 0.6 + 0.4; // always < a miss plus an extra word (2)
};

/** Order-preserving pairs [scriptIndex, recognisedIndex]. A substitution is cheaper than a miss. */
function pair(script: string[], rec: Recognised[]): [number, number][] {
  const n = script.length, m = rec.length;
  const d = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) d[i]![0] = i;
  for (let j = 1; j <= m; j++) d[0]![j] = j;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + subCost(script[i - 1]!, rec[j - 1]!.word));
  const out: [number, number][] = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (d[i]![j] === d[i - 1]![j - 1]! + subCost(script[i - 1]!, rec[j - 1]!.word)) { out.push([i - 1, j - 1]); i--; j--; }
    else if (d[i]![j] === d[i - 1]![j]! + 1) i--;
    else j--;
  }
  return out.reverse();
}

/** Recognised indexes that sit in a run of 3 or more equal words. */
function loopIndexes(rec: Recognised[]): Set<number> {
  const out = new Set<number>();
  for (let s = 0; s < rec.length; ) {
    let e = s + 1;
    while (e < rec.length && norm(rec[e]!.word) === norm(rec[s]!.word)) e++;
    if (e - s >= 3) for (let k = s; k < e; k++) out.add(k);
    s = e;
  }
  return out;
}

/** Times are monotone and never overlap; a word may be zero-width but never negative. */
function tidy(words: CaptionWord[]): void {
  let t = 0;
  for (const w of words) {
    w.startS = Math.max(w.startS, t);
    w.endS = Math.max(w.endS, w.startS);
    t = w.endS;
  }
}

/** Every word ends up inside [0, durationS], monotone and non-overlapping. */
export function mapToScript(script: string[], recognised: Recognised[], durationS: number): MapResult {
  const pairs = pair(script, recognised);
  const stats = { scriptWords: script.length, recognisedWords: recognised.length, matched: pairs.length };
  if (pairs.length === 0) return { words: [], stats };

  const loops = loopIndexes(recognised);
  const drift = Math.abs(recognised.length - script.length) / Math.max(script.length, 1) > MAX_COUNT_DRIFT;
  const words: (CaptionWord | undefined)[] = new Array(script.length).fill(undefined);
  for (const [si, ri] of pairs) {
    const r = recognised[ri]!;
    const flags: AlignFlag[] = [];
    if (r.p < LOW_P) flags.push("low_confidence");
    if (r.endS - r.startS < MIN_WORD_S) flags.push("too_short");
    if (r.endS - r.startS > MAX_WORD_S) flags.push("too_long");
    if (loops.has(ri)) flags.push("loop");
    words[si] = { word: script[si]!, startS: r.startS, endS: r.endS, source: "recognised", flags };
  }
  const avg = pairs.reduce((a, [, ri]) => a + recognised[ri]!.endS - recognised[ri]!.startS, 0) / pairs.length;
  for (let i = 0; i < script.length; ) {
    if (words[i]) { i++; continue; }
    let e = i;
    while (e < script.length && !words[e]) e++;
    const prev = words[i - 1], next = words[e];
    const from = prev ? prev.endS : Math.max(0, next!.startS - (e - i) * avg);
    const to = next ? next.startS : Math.min(from + (e - i) * avg, durationS);
    const step = (Math.max(to, from) - from) / (e - i);
    for (let k = i; k < e; k++) words[k] = { word: script[k]!, startS: from + (k - i) * step, endS: from + (k - i + 1) * step, source: "interpolated", flags: ["interpolated"] };
    i = e;
  }
  const out = words as CaptionWord[];
  tidy(out);
  for (const w of out) { w.startS = Math.min(w.startS, durationS); w.endS = Math.min(w.endS, durationS); } // min keeps order
  if (drift) for (const w of out) w.flags.push("count_mismatch");
  return { words: out, stats };
}

/** Even spread inside the chunk. Always estimated; callers must treat it as approximate. */
export function estimateTimings(script: string[], durationS: number): CaptionWord[] {
  const step = durationS / Math.max(script.length, 1);
  return script.map((word, i) => ({ word, startS: i * step, endS: (i + 1) * step, source: "estimated" as const, flags: [] }));
}

/** te/kn/ml aligned timings are a draft until re-tested with real narration (ADR 0008): every word is flagged. */
export function flagLanguage(lang: Lang, words: CaptionWord[]): void {
  if (UNRELIABLE_LANGS.includes(lang)) for (const w of words) if (!w.flags.includes("language_unreliable")) w.flags.push("language_unreliable");
}

export function captionsBody(timingsKind: TimingsKind, words: CaptionWord[]): CaptionsBody {
  const flags = [...new Set(words.flatMap((w) => w.flags))];
  return {
    timings_kind: timingsKind,
    words,
    needs_check: timingsKind === "estimated" || flags.length > 0,
    flags,
    approximate: timingsKind === "estimated" || flags.includes("language_unreliable"),
  };
}

/** Best available source: native, then aligned, then estimated. `none` is refused. */
export function pickTimingsKind(available: ReadonlyArray<TimingsKind | "none">): TimingsKind {
  for (const k of ["native", "aligned", "estimated"] as const) if (available.includes(k)) return k;
  throw new Error("No word timings available from this provider (word_timings is none); pick another voice or provider.");
}

/** Groups consecutive lines into chunks of at most maxS seconds (a single longer line stays alone). Returns line indexes. */
export function splitForAlignment(lines: string[], durations: number[], maxS = 15): number[][] {
  if (lines.length !== durations.length) throw new Error("splitForAlignment: lines and durations differ in length");
  const out: number[][] = [];
  let sum = 0;
  lines.forEach((_, i) => {
    const cur = out[out.length - 1];
    if (cur && sum + durations[i]! <= maxS) { cur.push(i); sum += durations[i]!; }
    else { out.push([i]); sum = durations[i]!; }
  });
  return out;
}
