// Split caption text into runs by writing system so each run gets its own font. Pure; no Remotion imports.
export type Script = "latin" | "devanagari" | "tamil" | "telugu" | "kannada" | "malayalam";
export type Run = { text: string; script: Script };

const INDIC: [Script, RegExp][] = [
  ["devanagari", /[ऀ-ॿ꣠-ꣿ]/u],
  ["tamil", /[஀-௿]/u],
  ["telugu", /[ఀ-౿]/u],
  ["kannada", /[ಀ-೿]/u],
  ["malayalam", /[ഀ-ൿ]/u],
];
const LATIN = /\p{Script=Latin}/u;

function scriptOf(ch: string): Script | null {
  for (const [s, re] of INDIC) if (re.test(ch)) return s;
  return LATIN.test(ch) ? "latin" : null; // digits, spaces, punctuation, emoji: neutral
}

/** Runs of text by script. Neutral characters (digits, emoji, punctuation, spaces) join the previous run. */
export function splitByScript(text: string): Run[] {
  const runs: Run[] = [];
  for (const ch of text) {
    const s = scriptOf(ch);
    const last = runs[runs.length - 1];
    if (last && (s === null || s === last.script)) last.text += ch;
    else runs.push({ text: ch, script: s ?? "latin" });
  }
  return runs;
}
