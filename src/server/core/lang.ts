// Doc 02 language rules, ported from the old lang.py. Pure: no IO. Speaking rates are planning estimates (words per
// second); Indic words are longer, so fewer fit in a second. The word range scales the English 60-150 (~100) short.

export const LANGS = ["en", "hi", "ta", "te", "ml", "kn"] as const;
export type Lang = (typeof LANGS)[number];

const INFO: Record<Lang, { name: string; script: string; wps: number }> = {
  en: { name: "English", script: "Latin", wps: 2.7 },
  hi: { name: "Hindi", script: "Devanagari", wps: 2.8 },
  ta: { name: "Tamil", script: "Tamil", wps: 2.0 },
  te: { name: "Telugu", script: "Telugu", wps: 2.1 },
  ml: { name: "Malayalam", script: "Malayalam", wps: 1.8 },
  kn: { name: "Kannada", script: "Kannada", wps: 2.1 },
};
const EN_WPS = INFO.en.wps;

export function isLang(x: unknown): x is Lang {
  return typeof x === "string" && (LANGS as readonly string[]).includes(x);
}

/** Spoken words: split on whitespace. A \w-style regex drops Indic combining vowel signs and would miscount. */
export function wordCount(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}

/** Spoken words per second at the language's normal pace. */
export const speakingRate = (lang: Lang): number => INFO[lang].wps;

export function wordRange(lang: Lang, speakingRate: number = INFO[lang].wps): { min: number; max: number } {
  if (!(speakingRate > 0) || !Number.isFinite(speakingRate)) throw new Error("speakingRate must be a positive number");
  const f = speakingRate / EN_WPS;
  return { min: Math.round(60 * f), max: Math.round(150 * f) };
}

export function draftInstruction(lang: Lang): string {
  if (lang === "en") return "";
  const { name, script } = INFO[lang];
  const { min, max } = wordRange(lang);
  const target = Math.round((100 * INFO[lang].wps) / EN_WPS);
  return (
    `LANGUAGE: write ALL viewer-facing text (narration, on-screen words, the title) in ${name} using the ${script} script. ` +
    `Keep beat ids and file names in English. Aim for about ${target} spoken words (${min}-${max}); ${name} words are longer than English ones. ` +
    "Do not transliterate into Latin letters. Evidence claim text may be written in English."
  );
}
