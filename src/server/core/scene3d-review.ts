import { z } from "zod";

// The automatic look loop of an AI-written 3D story (Phase 5e slice 3). Pure: no IO, no model, no clock.
// After the preview pictures are drawn, the review stage checks them (scene3d-look-check.ts). If there are problems and fewer than
// MAX_AUTO_ROUNDS revisions were made, the author is asked to revise the scene; the pipeline hash of the author carries the round, so
// author -> pictures -> review run again by themselves. At the end the owner gets the BEST scene seen, with what is still wrong.
//
// How "keep the better round" works: every review body carries the whole history (round, scene fingerprint, number of problems). When
// the loop stops and the last scene is not the best one (fewer problems wins; on a tie the later round wins), the review stage saves
// the best round's scene again as the newest `scenes` content (and scene.tsx). The pictures are then drawn again from it and the review
// runs once more as a CONFIRMATION (same round, no new revision), so the Look gate always shows pictures of exactly the scene Render will draw.

/** The most automatic revisions of one scene. The owner's own send-backs (max 3, scene3d-view.ts) are separate and each one restarts this count. */
export const MAX_AUTO_ROUNDS = 3;
export const MAX_ADVICE_SENTENCES = 8;
export const ADVICE_SENTENCE_MAX = 160;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const reviewBodySchema = z.object({
  kind: z.literal("scene3d_review"),
  /** How many automatic revisions the reviewed scene has had (0 = the first draft). */
  round: z.number().int().min(0).max(MAX_AUTO_ROUNDS),
  /** The owner's send-backs so far when this review was made: a newer send-back restarts the rounds. */
  look_count: z.number().int().min(0).max(10),
  /** sha256 of the narration content this review belongs to: a new narration restarts the rounds. */
  narration_sha: z.string().max(64),
  /** source_sha256 of the scene that was reviewed. */
  scene_sha256: hex64,
  /** Plain sentences made by OUR code (scene3d-look-check.ts). */
  problems: z.array(z.string().max(300)).max(8),
  /** Sentences from the picture-check model, already cleaned. Advice only. */
  advice: z.array(z.string().max(ADVICE_SENTENCE_MAX)).max(MAX_ADVICE_SENTENCES),
  passed: z.boolean(),
  /** True = the author is asked for another revision. */
  revise: z.boolean(),
  stop_reason: z.enum(["passed", "max_rounds", "budget"]).nullable(),
  history: z.array(z.object({ round: z.number().int().min(0).max(MAX_AUTO_ROUNDS), scene_sha256: hex64, problems: z.number().int().min(0).max(8) })).min(1).max(MAX_AUTO_ROUNDS + 1),
  /** The round whose scene the owner is shown (the best one once the loop has stopped). */
  best_round: z.number().int().min(0).max(MAX_AUTO_ROUNDS),
  /** Set when the loop stopped on a worse scene: the fingerprint of the better scene that is being put back. */
  restore_sha256: hex64.nullable(),
});
export type ReviewBody = z.infer<typeof reviewBodySchema>;

export function readReview(body: unknown): ReviewBody | null {
  const r = reviewBodySchema.safeParse(body);
  return r.success ? r.data : null;
}

/** The review that still describes this video, or null (an older owner send-back or another narration makes it history). */
export function activeReview(body: unknown, lookCount: number, narrationSha: string | null): ReviewBody | null {
  const r = readReview(body);
  return r && r.look_count === lookCount && narrationSha !== null && r.narration_sha === narrationSha ? r : null;
}

/** The number in the author's pipeline hash: revisions asked for so far. 0 (also: no review) adds nothing to the hash. */
export const authorRoundOf = (r: ReviewBody | null): number => (r ? (r.revise ? r.round + 1 : r.round) : 0);

/** One model sentence made safe to quote back to a model: no code, links, markup or odd characters; one line; at most 160 characters. */
export function cleanAdvice(s: unknown): string {
  const t = (typeof s === "string" ? s : "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`/g, " ")
    .replace(/\b(?:https?|ftp|file|data|javascript):\S*/gi, " ")
    .replace(/\b(?:www\.)\S+/gi, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff<>{}\[\]\\|]/g, " ")
    .replace(/(BEGIN|END)[_ ]DATA/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > ADVICE_SENTENCE_MAX ? `${t.slice(0, ADVICE_SENTENCE_MAX - 3).trimEnd()}...` : t;
}

/** At most 8 cleaned, non-empty, distinct sentences. */
export function cleanAdviceList(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const x of list) {
    const c = cleanAdvice(x);
    if (c !== "" && !out.includes(c)) out.push(c);
    if (out.length >= MAX_ADVICE_SENTENCES) break;
  }
  return out;
}

export interface ReviewInput {
  sceneSha256: string;
  problems: string[];
  advice: string[];
  lookCount: number;
  narrationSha: string;
  /** False when the budget left for this video cannot pay for another author call. */
  budgetOk: boolean;
}

/** The next review body from the previous ACTIVE one (null = none) and what the pictures show now. */
export function decideReview(prior: ReviewBody | null, a: ReviewInput): ReviewBody {
  const common = { kind: "scene3d_review" as const, look_count: a.lookCount, narration_sha: a.narrationSha, scene_sha256: a.sceneSha256, problems: a.problems.slice(0, 8), advice: cleanAdviceList(a.advice), passed: a.problems.length === 0 };
  // Confirmation: the previous review put the better scene back; these are the pictures of it. Same round, no new revision, no new history.
  if (prior && !prior.revise && prior.restore_sha256 !== null && prior.restore_sha256 === a.sceneSha256) {
    return { ...common, round: prior.round, revise: false, stop_reason: prior.stop_reason, history: prior.history, best_round: prior.best_round, restore_sha256: null };
  }
  const base = prior && prior.revise ? prior : null;
  const round = base ? Math.min(MAX_AUTO_ROUNDS, base.round + 1) : 0;
  const history = [...(base?.history ?? []), { round, scene_sha256: a.sceneSha256, problems: common.problems.length }];
  const stop = common.passed ? "passed" : round >= MAX_AUTO_ROUNDS ? "max_rounds" : !a.budgetOk ? "budget" : null;
  const revise = stop === null;
  const best = history.reduce((x, y) => (y.problems <= x.problems ? y : x)); // fewer problems wins; on a tie the later round
  return {
    ...common,
    round,
    revise,
    stop_reason: stop,
    history,
    best_round: revise ? round : best.round,
    restore_sha256: !revise && best.round !== round ? best.scene_sha256 : null,
  };
}

/** What the author reads in a revision round: our own problem sentences plus the cleaned picture-check sentences. */
export interface ReviewFeedback {
  round: number;
  problems: string[];
  advice: string[];
}
export function feedbackFrom(r: ReviewBody | null): ReviewFeedback | null {
  return r && r.revise ? { round: r.round + 1, problems: r.problems.slice(0, 8), advice: cleanAdviceList(r.advice) } : null;
}

// ---- the Look card -------------------------------------------------------------------------------------------------

export interface ReviewView {
  /** Automatic revisions made for the scene shown. */
  rounds: number;
  /** Problems found in the first draft, and how many are still there in the scene shown. */
  firstFound: number;
  remainingCount: number;
  fixed: number;
  remaining: string[];
  advice: string[];
  /** The round whose scene and pictures are shown. */
  shownRound: number;
  stopReason: "passed" | "max_rounds" | "budget" | null;
  passed: boolean;
}

export function reviewView(body: unknown): ReviewView | null {
  const r = readReview(body);
  if (!r) return null;
  const shown = r.history.find((h) => h.round === r.best_round) ?? r.history[r.history.length - 1]!;
  const first = r.history[0]!.problems;
  return {
    rounds: shown.round,
    firstFound: first,
    remainingCount: r.problems.length,
    fixed: Math.max(0, first - r.problems.length),
    remaining: r.problems,
    advice: r.advice,
    shownRound: shown.round,
    stopReason: r.stop_reason,
    passed: r.passed,
  };
}

/** One plain sentence for the Look card. */
export function reviewSummary(v: ReviewView): string {
  const rounds = v.rounds === 0 ? "the first draft" : `after ${v.rounds} automatic ${v.rounds === 1 ? "revision" : "revisions"}`;
  if (v.passed) return v.rounds === 0 ? "The automatic picture checks found nothing to fix in the first draft." : `The automatic picture checks pass ${rounds}.`;
  const why = v.stopReason === "budget" ? " It stopped early because the money left for this video would not pay for another try." : v.stopReason === "max_rounds" ? " It stopped at the limit of 3 automatic revisions." : "";
  return `You are looking at ${rounds}: ${v.fixed} of ${v.firstFound} problems fixed, ${v.remainingCount} still there.${why}`;
}
