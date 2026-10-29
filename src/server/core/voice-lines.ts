import { createHash } from "node:crypto";
import type { Lang } from "./lang";

// Voice lines (Phase 3 T04). Pure: no IO. Counts are by Unicode code point on NFC text.

export interface VoiceLine {
  index: number;
  text: string;
  textSha256: string;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// Virama of each Indic script we speak: a cut right after one would split a conjunct.
const VIRAMA = new Set([0x94d, 0x9cd, 0xa4d, 0xacd, 0xb4d, 0xbcd, 0xc4d, 0xccd, 0xd4d]);
const JOINER = /[‌‍]/u;
const MARK = /\p{M}/u;

/** A cut before cps[i] is allowed unless it would split a combining sequence, a ZWJ/ZWNJ join or a virama conjunct. */
function canCutBefore(cps: string[], i: number): boolean {
  const next = cps[i]!;
  if (MARK.test(next) || JOINER.test(next)) return false;
  const prev = cps[i - 1]!;
  return !(JOINER.test(prev) || VIRAMA.has(prev.codePointAt(0)!));
}

/** Cuts one over-long sentence: at the last space within the limit, else at the last safe code point boundary. */
function hardSplit(sentence: string, maxChars: number): string[] {
  const out: string[] = [];
  let cps = Array.from(sentence);
  while (cps.length > maxChars) {
    let cut = -1;
    for (let i = maxChars; i > 0; i--) {
      if (/\s/u.test(cps[i]!)) {
        cut = i;
        break;
      }
    }
    if (cut < 0) {
      cut = maxChars;
      while (cut > 0 && !canCutBefore(cps, cut)) cut--;
      // No safe boundary within the limit (one cluster longer than maxChars): cut at the limit. The limit is never exceeded.
      if (cut === 0) cut = maxChars;
    }
    out.push(cps.slice(0, cut).join("").trim());
    cps = Array.from(cps.slice(cut).join("").trimStart());
  }
  if (cps.length > 0) out.push(cps.join("").trim());
  return out.filter(Boolean);
}

/**
 * Splits narration at sentence ends (. ? ! । ॥ and newlines), keeping the punctuation. Lines are trimmed; lines with no
 * letter or digit are dropped, never sent. A sentence over `maxChars` code points is cut at the last space before the limit.
 */
export function splitLines(narration: string, _lang: Lang, maxChars = 3500): VoiceLine[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("maxChars must be a positive integer");
  const sentences = narration.normalize("NFC").split(/\n+|(?<=[।॥])(?![।॥])|(?<=[.?!])(?=\s)/u);
  const texts = sentences.map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s));
  return texts.flatMap((s) => hardSplit(s, maxChars)).map((text, index) => ({ index, text, textSha256: sha256(text) }));
}

/** sha256 of canonical JSON (fixed field order, settings keys sorted): any change to a field is a different key. */
export function lineCacheKey(l: { text: string; voice: string; model: string; lang: Lang; settings: Record<string, string | number> }): string {
  const settings = Object.fromEntries(Object.keys(l.settings).sort().map((k) => [k, l.settings[k]]));
  return sha256(JSON.stringify({ lang: l.lang, model: l.model, settings, text: l.text, voice: l.voice }));
}

/** 1 when the clip fits its window; clip/window up to the cap; above the cap `fits` is false: flag the line for rewrite, never chop it. */
export function tempoFitFactor(clipS: number, windowS: number, cap = 1.15): { factor: number; fits: boolean } {
  for (const n of [clipS, windowS, cap]) if (!Number.isFinite(n) || n <= 0) throw new Error("clip, window and cap must be positive finite numbers");
  if (clipS <= windowS) return { factor: 1, fits: true };
  const ratio = clipS / windowS;
  return { factor: ratio, fits: ratio <= cap };
}
