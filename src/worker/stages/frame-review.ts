import { logSafe, parseFrameReview, reviewMessages, reviewUserText, REVIEW_MAX_OUTPUT_TOKENS, type FrameReview } from "@/server/core/frame-review";
import { BudgetRefusedError, KnownFailure } from "@/server/core/paid-call";
import { UnpricedCallError } from "@/server/core/spend";
import { TSX_META } from "@/server/core/tsx-check";
import { beatTimings, type PromptBeat, type PromptWord, type TimedBeat } from "@/server/core/tsx-prompt";
import { LlmRefusal, type LlmClient, type LlmStageContext } from "@/server/llm/client";

// The frame review of a code scene, as the tsx_author stage uses it: where to look (the beats' midpoints) and the one paid
// vision call. It NEVER fails the animation: a missing vision model, a budget that does not fit, a failed or unreadable
// call all give a skipped/unavailable verdict. Only the cases that must stop the stage go up untouched: an unclear paid
// outcome (the money may be spent: the owner decides) and a cancel or lost lease.

const fr = (s: number) => Math.round(s * TSX_META.fps);
export type ReviewBeat = TimedBeat & { startFrame: number; endFrame: number };

/** The beats with their frame ranges (real timings when the narration matched the beats, else the estimates). */
export function reviewBeats(beats: readonly PromptBeat[], words: readonly PromptWord[], narrationS: number): ReviewBeat[] {
  return beatTimings(beats, words, narrationS).map((b) => {
    const real = b.realStartS !== undefined && b.realEndS !== undefined;
    return { ...b, startFrame: fr(real ? b.realStartS! : b.estStartS), endFrame: fr(real ? b.realEndS! : b.estEndS) };
  });
}

/** One frame in the middle of every beat: what the viewer sees while that beat is spoken. */
export const beatMidFrames = (timed: readonly ReviewBeat[]): number[] => timed.map((b) => Math.floor((b.startFrame + b.endFrame) / 2));

export const SKIP_NO_VISION = "frame review skipped: no vision model";

/** Whether a review can run at all, checked BEFORE extra stills are rendered. A skipped verdict, or null when it can. */
export const REVIEW_MAX_FRAMES = 8;
/** At most `n` items, the first and last kept and the rest spread evenly, in order. */
export function evenly<T>(xs: readonly T[], n: number): T[] {
  if (xs.length <= n) return [...xs];
  return Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]!);
}

export async function reviewReady(llm: LlmClient): Promise<FrameReview | null> {
  const why = (await llm.routeProblem?.("review_frames")) ?? null;
  return why === null ? null : { status: "skipped", reason: `${SKIP_NO_VISION} (${logSafe(why)})` };
}

export async function reviewShots(
  llm: LlmClient,
  ctx: LlmStageContext,
  timed: readonly ReviewBeat[],
  shots: readonly { frame: number; jpeg: Uint8Array }[],
  style?: string | null,
): Promise<FrameReview> {
  // At most REVIEW_MAX_FRAMES pictures per call (some models, Claude Code here, take 8): spread evenly over the video.
  const picked = evenly(shots, REVIEW_MAX_FRAMES);
  try {
    const r = await llm.vision(ctx, {
      stage: "review_frames",
      messages: reviewMessages(reviewUserText(picked, timed, style)),
      images: picked.map((s) => ({ data: s.jpeg, mediaType: "image/jpeg" as const })),
      maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS,
    });
    return parseFrameReview(r.text, picked.map((s) => s.frame));
  } catch (err) {
    if (err instanceof LlmRefusal) return { status: "skipped", reason: `${SKIP_NO_VISION} (${logSafe(err.message)})` };
    if (err instanceof UnpricedCallError) return { status: "skipped", reason: "frame review skipped: the vision model has no usable price" };
    if (err instanceof BudgetRefusedError) return { status: "skipped", reason: "frame review skipped: it does not fit in what is left of the budget for this video" };
    if (err instanceof KnownFailure) return { status: "unavailable", reason: `frame review unavailable: the model call failed (${logSafe(err.message)}); nothing was charged` };
    throw err; // an unclear paid outcome, a cancel, a lost lease: never swallowed, never retried
  }
}

/**
 * Replay-safe step numbers. Every attempt uses exactly two paid step numbers: the author call, then one slot for the review,
 * whether or not a review call is made (off, skipped, render failed before the stills). So a route change between a crash and
 * the retry cannot shift the numbers a resumed run replays by. `reviewCtx` marks the slot used when it pays.
 */
export function reviewSlots(ctx: { signal: AbortSignal; nextStep(): number; paid: LlmStageContext["paid"] }): { beforeAsk(): void; reviewCtx: LlmStageContext } {
  let used = true; // the first attempt has no earlier slot to burn
  return {
    beforeAsk() {
      if (!used) ctx.nextStep();
      used = false;
    },
    reviewCtx: { signal: ctx.signal, paid: (s, call) => { used = true; return ctx.paid(s, call); } },
  };
}
