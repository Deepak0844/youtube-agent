import { logSafe, parseFrameReview, reviewMessages, reviewUserText, REVIEW_MAX_OUTPUT_TOKENS, type FrameReview } from "@/server/core/frame-review";
import { BudgetRefusedError, KnownFailure } from "@/server/core/paid-call";
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
export async function reviewReady(llm: LlmClient): Promise<FrameReview | null> {
  const why = (await llm.routeProblem?.("review_frames")) ?? null;
  return why === null ? null : { status: "skipped", reason: `${SKIP_NO_VISION} (${logSafe(why)})` };
}

export async function reviewShots(
  llm: LlmClient,
  ctx: LlmStageContext,
  timed: readonly ReviewBeat[],
  shots: readonly { frame: number; jpeg: Uint8Array }[],
): Promise<FrameReview> {
  try {
    const r = await llm.vision(ctx, {
      stage: "review_frames",
      messages: reviewMessages(reviewUserText(shots, timed)),
      images: shots.map((s) => ({ data: s.jpeg, mediaType: "image/jpeg" as const })),
      maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS,
    });
    return parseFrameReview(r.text, shots.map((s) => s.frame));
  } catch (err) {
    if (err instanceof LlmRefusal) return { status: "skipped", reason: `${SKIP_NO_VISION} (${logSafe(err.message)})` };
    if (err instanceof BudgetRefusedError) return { status: "skipped", reason: "frame review skipped: it does not fit in what is left of the budget for this video" };
    if (err instanceof KnownFailure) return { status: "unavailable", reason: `frame review unavailable: the model call failed (${logSafe(err.message)}); nothing was charged` };
    throw err; // an unclear paid outcome, a cancel, a lost lease: never swallowed, never retried
  }
}
