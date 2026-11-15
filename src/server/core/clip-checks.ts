// Clip Factory CF3a: the automatic checks every clip passes before it reaches the owner's batch gate. Pure: no IO.
// Owner decision 2026-11-16: hook within 3 s, even loudness, captions match the speech. A failed clip is NOT dropped: it stays in the
// batch with a warning and the owner decides. Times are clip-relative (the caption words already start at 0).
import { LEADS_BACK } from "@/server/core/clip-moments";
import { FINDING_DEFAULTS } from "@/server/core/qa-findings";

export type ClipCheckId = "hook" | "loudness" | "captions";
export interface ClipCheck {
  id: ClipCheckId;
  ok: boolean;
  /** A plain sentence for the owner when the check did not pass; null when it passed. */
  warning: string | null;
}
export interface ClipWord {
  word: string;
  startS: number;
  endS: number;
}
export interface ClipFacts {
  /** the caption words of the clip, starting at 0 */
  words: readonly ClipWord[];
  durationS: number;
  /** integrated loudness and true peak of the finished clip (from the loudness scan); null when it could not be measured */
  lufs: number | null;
  truePeakDb: number | null;
}
export const HOOK_START_S = 3;
export const HOOK_MAX_WORDS = 25;
export const CAPTION_COVERAGE_MIN = 0.7;
const SENTENCE_END = /[.!?।]["'”’)\]]*$/u;

const pass = (id: ClipCheckId): ClipCheck => ({ id, ok: true, warning: null });
const warn = (id: ClipCheckId, warning: string): ClipCheck => ({ id, ok: false, warning });

/** The first words of the clip are spoken within 3 s and form a real opener (not a joining word, not a long preamble). */
export function hookCheck(words: readonly ClipWord[]): ClipCheck {
  const first = words[0];
  if (!first) return warn("hook", "The clip has no spoken words, so it has no hook.");
  if (!Number.isFinite(first.startS)) return warn("hook", "The first word has no valid time.");
  if (first.startS > HOOK_START_S) return warn("hook", `The first word is spoken ${first.startS.toFixed(1)} s in; a hook should start within ${HOOK_START_S} s.`);
  const end = words.findIndex((w) => SENTENCE_END.test(w.word));
  const opener = words.slice(0, end === -1 ? words.length : end + 1);
  if (LEADS_BACK.test(opener.map((w) => w.word).join(" "))) return warn("hook", "The clip opens with a joining word (and, but, because...): it starts mid-thought.");
  if (opener.length > HOOK_MAX_WORDS) return warn("hook", `The first sentence is ${opener.length} words long; a hook is ${HOOK_MAX_WORDS} words or fewer.`);
  return pass("hook");
}

/** Loudness inside the app's own range (qa-findings), and no clipping. An unmeasured clip is a warning, not a pass. */
export function loudnessCheck(lufs: number | null, truePeakDb: number | null): ClipCheck {
  const d = FINDING_DEFAULTS;
  if (lufs === null || !Number.isFinite(lufs)) return warn("loudness", "The loudness of this clip could not be measured.");
  if (lufs < d.lufsMin || lufs > d.lufsMax) return warn("loudness", `Loudness is ${lufs.toFixed(1)} LUFS; aim for ${d.lufsMin} to ${d.lufsMax} so the batch sounds even.`);
  if (truePeakDb !== null && Number.isFinite(truePeakDb) && truePeakDb > d.truePeakMax) return warn("loudness", `Audio peaks at ${truePeakDb.toFixed(1)} dBTP and may clip (limit ${d.truePeakMax}).`);
  return pass("loudness");
}

/** The caption words sit inside the clip, in order, and cover most of it (a clip with a long caption-less stretch is not matched to its speech). */
export function captionsCheck(words: readonly ClipWord[], durationS: number): ClipCheck {
  if (!(durationS > 0)) return warn("captions", "The clip has no length.");
  if (words.length === 0) return warn("captions", "The clip has no caption words.");
  let prevStart = -Infinity;
  for (const w of words) {
    if (!Number.isFinite(w.startS) || !Number.isFinite(w.endS) || w.endS < w.startS || w.startS < prevStart) return warn("captions", "The caption times are not valid or not in order.");
    prevStart = w.startS;
  }
  const first = words[0]!;
  const last = words.at(-1)!;
  if (first.startS < 0 || last.endS > durationS + 0.1) return warn("captions", "A caption word falls outside the clip (a word is cut off at the start or the end).");
  const coverage = (last.endS - first.startS) / durationS;
  if (coverage < CAPTION_COVERAGE_MIN) return warn("captions", `The captions cover only ${Math.round(coverage * 100)}% of the clip; the speech and the captions may not match.`);
  return pass("captions");
}

/** All three checks. `ok` is true only when every check passed; `warnings` lists the plain sentences for the batch screen. */
export function checkClip(f: ClipFacts): { ok: boolean; checks: ClipCheck[]; warnings: string[] } {
  const checks = [hookCheck(f.words), loudnessCheck(f.lufs, f.truePeakDb), captionsCheck(f.words, f.durationS)];
  return { ok: checks.every((c) => c.ok), checks, warnings: checks.flatMap((c) => (c.warning ? [c.warning] : [])) };
}
