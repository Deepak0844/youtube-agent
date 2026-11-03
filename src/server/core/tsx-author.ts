import type { Message } from "@/server/core/agent-loop";
import { KnownFailure } from "@/server/core/paid-call";
import { logSafe, reviewProblems, type FrameReview } from "@/server/core/frame-review";
import { checkTsx, echo, tsxDuration } from "@/server/core/tsx-check";
import { extractTsx, retryMessages, targetFrames, tsxSystemPrompt, tsxUserPrompt, type FeedbackStep, type TsxTask } from "@/server/core/tsx-prompt";

// The code-scene author loop (ADR 0009 guardrails): the model writes one file, the app checks it, previews it and renders it.
// Per attempt: reply -> one tsx block -> static check -> length check -> renderTsx (type-check, preview stills at frames 0,
// middle and last, full render). Any problem goes back to the model as a short list and the whole file is asked for again.
//
// The caps: at most MAX_ATTEMPTS model calls (2 retries); the same problem list twice in a row stops early (a third try would
// spend the same money to get the same answer). The model call is injected and is the reserved, budget-scoped paid call, so
// a refused budget or an unclear paid outcome is thrown out of here untouched: it is never caught and never retried.
// Only a typed render failure is handled. An infrastructure failure (folders, settings) is not the model's fault: it throws a
// KnownFailure instead of spending another attempt.

export const TSX_MAX_ATTEMPTS = 3;
/** The model may run this many frames LONGER than the exact length (0.5 s) but at most 3 SHORTER, so the narration is never clipped. */
export const TSX_FRAME_SLACK = 15;
export const TSX_FRAME_SHORT_SLACK = 3;
const MAX_LOG = 120;

// The shape renderTsx returns (providers/renderer/tsx-render.ts); kept here so core code does not import a provider.
type TsxFailureKind = "check" | "typecheck" | "render" | "timeout" | "preflight" | "output" | "review" | "infra";
type TsxRenderResult = { ok: true; outPath: string; image: string; stills?: string[] } | { ok: false; error: { kind: TsxFailureKind; message: string; problems: string[] } };

export interface AuthorDeps {
  /** One reserved, paid model call; returns the raw reply. */
  ask(messages: Message[]): Promise<string>;
  /** renderTsx for a checked source (it checks and type-checks again, renders the stills, then the video). `review`, when given, is passed on as renderTsx's frame-review hook. */
  render(source: string, review?: (shots: ReviewShotLike[]) => Promise<string[] | null>): Promise<TsxRenderResult>;
  /**
   * The frame review of one attempt's key frames (one paid vision call, or a skipped/unavailable verdict; it never fails the
   * animation). Absent = no review. A budget refusal or unclear paid outcome is thrown out of here untouched, like `ask`.
   */
  review?(shots: ReviewShotLike[]): Promise<FrameReview>;
  log(line: string): void;
}
export type ReviewShotLike = { frame: number; jpeg: Uint8Array };

export type { TsxRenderResult };
export type AuthorOutcome =
  | { ok: true; source: string; durationInFrames: number; outPath: string; image: string; stills: string[]; attempts: number; review: FrameReview | null }
  | { ok: false; attempts: number; why: "cap" | "repeat"; step: FeedbackStep; problems: string[]; review?: FrameReview | null };

const STEP_OF: Record<Exclude<TsxFailureKind, "infra">, FeedbackStep> = {
  check: "check", typecheck: "typecheck", render: "render", timeout: "timeout", preflight: "preflight", output: "output", review: "review",
};

export async function authorTsx(deps: AuthorDeps, task: TsxTask, maxAttempts: number = TSX_MAX_ATTEMPTS): Promise<AuthorOutcome> {
  const want = targetFrames(task.narrationS);
  const first: Message[] = [{ role: "system", content: tsxSystemPrompt() }, { role: "user", content: tsxUserPrompt(task) }];
  let messages = first;
  let lastSig = "";
  let review: FrameReview | null = null; // the verdict of the attempt that was finally rendered
  const cap = Math.max(1, Math.min(TSX_MAX_ATTEMPTS, Math.trunc(maxAttempts)));
  // The attempt a reviewer rejected (fewest bad frames, else the latest) is a working scene. If a later attempt breaks or the cap
  // is hit, it is rendered once without the review (no paid call) instead of dropping the whole video to the scene kit.
  let best: { source: string; frames: number; review: FrameReview; bad: number; attempt: number } | null = null;
  const stop = async (attempt: number, why: "cap" | "repeat", step: FeedbackStep, problems: string[]): Promise<AuthorOutcome> => {
    if (best) {
      const r = await deps.render(best.source);
      if (r.ok) {
        deps.log(`tsx: using attempt ${best.attempt}, reviewer concerns remain`);
        return { ok: true, source: best.source, durationInFrames: best.frames, outPath: r.outPath, image: r.image, stills: r.stills ?? [], attempts: attempt, review: best.review };
      }
      if (r.error.kind === "infra") throw new KnownFailure(r.error.message);
    }
    return { ok: false, attempts: attempt, why, step, problems, review: best?.review ?? review };
  };
  for (let attempt = 1; ; attempt++) {
    const reply = await deps.ask(messages);
    let step: FeedbackStep;
    let problems: string[];
    let source: string | null = null;
    const ex = extractTsx(reply);
    if (!ex.ok) {
      step = "format";
      problems = [ex.problem];
    } else {
      source = ex.source;
      const checked = checkTsx(source);
      const frames = tsxDuration(source);
      if (!checked.ok) {
        step = "check";
        problems = checked.problems;
      } else if (frames === undefined || frames - want > TSX_FRAME_SLACK || want - frames > TSX_FRAME_SHORT_SLACK) {
        step = "timing";
        problems = [`meta: durationInFrames must be ${want} (the narration length); set it to ${want}.`];
      } else {
        // The review hook runs inside the render, after the stills pass and before the long video render. It asks for a retry only
        // while attempts remain: on the last attempt the verdict is kept and the video is rendered anyway (a warning shows).
        const n = attempt;
        const src = source;
        const fr = frames;
        const hook = deps.review
          ? async (shots: ReviewShotLike[]): Promise<string[] | null> => {
              const rv = await deps.review!(shots);
              review = rv;
              deps.log(`tsx: attempt ${n} frame review: ${rv.status === "done" ? (rv.ok ? "ok" : `${reviewProblems(rv).length} frame problem(s) found`) : logSafe(rv.reason)}`);
              const all = reviewProblems(rv);
              if (all.length > 0 && (!best || all.length <= best.bad)) best = { source: src, frames: fr, review: rv, bad: all.length, attempt: n };
              const found = n < cap ? all : [];
              return found.length > 0 ? found : null;
            }
          : undefined;
        review = null;
        const r = await deps.render(source, hook);
        if (r.ok) {
          deps.log(`tsx: attempt ${attempt} of ${cap} rendered`);
          return { ok: true, source, durationInFrames: frames, outPath: r.outPath, image: r.image, stills: r.stills ?? [], attempts: attempt, review };
        }
        if (r.error.kind === "infra") throw new KnownFailure(r.error.message);
        step = STEP_OF[r.error.kind];
        problems = [r.error.message, ...r.error.problems];
      }
    }
    deps.log(`tsx: attempt ${attempt} of ${cap} failed at ${step}: ${echo(problems[0] ?? "").slice(0, MAX_LOG)} (${problems.length} problem${problems.length === 1 ? "" : "s"})`);
    const sig = `${step}\n${problems.join("\n")}`;
    if (step !== "review" && sig === lastSig) return stop(attempt, "repeat", step, problems);
    if (attempt >= cap) return stop(attempt, "cap", step, problems);
    lastSig = sig;
    messages = retryMessages(first, source, step, problems);
  }
}
