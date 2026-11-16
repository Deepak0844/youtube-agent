// Clip Factory CF4b: what an approved clip INHERITS from its source video (owner decision 2026-11-16): the narration of its time window,
// beats made from that narration, and only the source's evidence claims that the clip actually states. Pure: no IO.
// Nothing here approves anything: the clip Short still passes the normal script, evidence, video and publish gates, and the evidence
// it inherits has no verification (a verification is bound to the exact claims, and only an owner session writes one).
import type { BatchClip } from "@/server/core/clip-batch";
import { scriptSchema, type Claim, type Script } from "@/server/core/script-contract";

export const CLAIM_OVERLAP_MIN = 0.6;
const SENTENCE_END = /[.!?।]["'”’)\]]*$/u;
const MAX_TITLE = 80;

const words = (s: string): string[] => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4 || /\d/.test(w));

/** True when at least CLAIM_OVERLAP_MIN of the claim's content words (4+ letters, or any number) are spoken in the clip. */
export function claimStatedIn(claim: Pick<Claim, "text">, narration: string): boolean {
  const need = [...new Set(words(claim.text))];
  if (need.length === 0) return false; // a claim with no content words cannot be matched, so it is not inherited
  const have = new Set(words(narration));
  return need.filter((w) => have.has(w)).length / need.length >= CLAIM_OVERLAP_MIN;
}

/** A title from the hook: its first sentence, at most 80 characters, cut at a word, without the final full stop. */
export function clipTitle(hook: string): string {
  const one = hook.replace(/\s+/g, " ").trim();
  const cut = one.length <= MAX_TITLE ? one : one.slice(0, MAX_TITLE).replace(/\s+\S*$/, "");
  const t = cut.replace(/[.!\s]+$/u, "").trim();
  return t.length > 0 ? t : "Clip";
}

/** Beats of the clip: one per spoken sentence, with times relative to the clip. */
export function clipBeats(c: Pick<BatchClip, "words">): Array<{ id: string; text: string; est_start: number; est_end: number }> {
  const beats: Array<{ id: string; text: string; est_start: number; est_end: number }> = [];
  let from = 0;
  const close = (to: number) => {
    const slice = c.words.slice(from, to + 1);
    beats.push({ id: `b${beats.length + 1}`, text: slice.map((w) => w.word).join(" "), est_start: slice[0]!.startS, est_end: slice.at(-1)!.endS });
    from = to + 1;
  };
  for (let i = 0; i < c.words.length; i++) if (i === c.words.length - 1 || SENTENCE_END.test(c.words[i]!.word)) close(i);
  return beats;
}

export interface InheritedScript {
  script: Script;
  /** how many of the source's claims the clip does not state, so they were left out */
  leftOutClaims: number;
}

/** The script a clip Short starts with, checked against the script contract; or a plain reason it cannot be made. */
export function inheritClipScript(source: { claims: readonly Claim[] }, clip: Pick<BatchClip, "words" | "hook">): { ok: true; value: InheritedScript } | { ok: false; reason: string } {
  const beats = clipBeats(clip);
  if (beats.length === 0) return { ok: false, reason: "The clip has no spoken words." };
  const narration = beats.map((b) => b.text).join(" ");
  const kept = source.claims.filter((c) => claimStatedIn(c, narration));
  const parsed = scriptSchema.safeParse({ narration, beats, title: clipTitle(clip.hook), evidence: kept });
  if (!parsed.success) return { ok: false, reason: "The clip's script is not valid: " + parsed.error.issues.slice(0, 3).map((i) => i.message).join("; ") };
  return { ok: true, value: { script: parsed.data, leftOutClaims: source.claims.length - kept.length } };
}
