import type { Lang } from "@/server/core/lang";
import { validateScript, type Script } from "@/server/core/script-contract";

// Evidence check for Draft (Doc 2 §8). Pure: no IO. A sourced claim only counts when its source_url is a page the app
// really fetched in this run and its quote appears in that page's text. The model cannot invent a source or a quote.
// Problems name the claim number and the rule, never text the model wrote.

/** NFKC, invisible/format characters dropped, whitespace collapsed, case folded. Applied to both the quote and the page. */
export function foldForQuote(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

export const MIN_QUOTE_CHARS = 25;
export const MIN_QUOTE_WORDS = 5;

const tokens = (s: string) => new Set(foldForQuote(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4));
const mostlyAscii = (s: string) => {
  const letters = [...s].filter((c) => /\p{L}/u.test(c));
  return letters.length > 0 && letters.filter((c) => c.charCodeAt(0) < 128).length / letters.length > 0.8;
};

/**
 * The claim text and its quote must share a key word or number. Only checked when both are in Latin letters: a claim
 * written in English about a quote in another script (allowed for Indic videos) cannot be compared this way.
 */
function anchored(claimText: string, quote: string): boolean {
  if (!mostlyAscii(claimText) || !mostlyAscii(quote)) return true;
  const q = tokens(quote);
  for (const t of tokens(claimText)) if (q.has(t)) return true;
  return false;
}

export type EvidenceCheck = { ok: true } | { ok: false; problems: string[] };

export function checkEvidence(script: Pick<Script, "evidence">, fetched: ReadonlyMap<string, string>): EvidenceCheck {
  const problems: string[] = [];
  const folded = new Map<string, string>();
  script.evidence.forEach((claim, i) => {
    if (claim.kind !== "sourced") return;
    const n = i + 1;
    const page = fetched.get(claim.source_url);
    if (page === undefined) {
      problems.push(`claim ${n}: source_url was not fetched in this run; cite only a page from the excerpts you were given`);
      return;
    }
    const quote = foldForQuote(claim.quote);
    if (quote === "") {
      problems.push(`claim ${n}: the quote is empty`);
      return;
    }
    if ([...quote].length < MIN_QUOTE_CHARS || quote.split(" ").length < MIN_QUOTE_WORDS) {
      problems.push(`claim ${n}: the quote is too short to prove anything; copy a full sentence (at least ${MIN_QUOTE_WORDS} words, ${MIN_QUOTE_CHARS} characters)`);
      return;
    }
    let text = folded.get(claim.source_url);
    if (text === undefined) {
      text = foldForQuote(page);
      folded.set(claim.source_url, text);
    }
    if (!text.includes(quote)) {
      problems.push(`claim ${n}: the quote does not appear on that page; copy the exact words from the excerpt`);
      return;
    }
    if (!anchored(claim.text, quote)) problems.push(`claim ${n}: the quote does not support what the claim says; they share no key word or number`);
  });
  return problems.length ? { ok: false, problems } : { ok: true };
}

/** The whole acceptance test for a draft: the script contract first, then the evidence against what was really fetched. */
export function judgeDraft(
  raw: unknown,
  lang: Lang,
  format: "short" | "long",
  fetched: ReadonlyMap<string, string>,
): { ok: true; script: Script } | { ok: false; problems: string[] } {
  const v = validateScript(raw, lang, format);
  if (!v.ok) return v;
  const e = checkEvidence(v.script, fetched);
  return e.ok ? { ok: true, script: v.script } : e;
}
