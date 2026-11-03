import type { Message } from "@/server/core/agent-loop";
import { KnownFailure } from "@/server/core/paid-call";
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
/** The model may be this many frames off the exact length (0.5 s); the video is still probed against its own meta by the renderer. */
export const TSX_FRAME_SLACK = 15;
const MAX_LOG = 120;

// The shape renderTsx returns (providers/renderer/tsx-render.ts); kept here so core code does not import a provider.
type TsxFailureKind = "check" | "typecheck" | "render" | "timeout" | "preflight" | "output" | "infra";
type TsxRenderResult = { ok: true; outPath: string; image: string } | { ok: false; error: { kind: TsxFailureKind; message: string; problems: string[] } };

export interface AuthorDeps {
  /** One reserved, paid model call; returns the raw reply. */
  ask(messages: Message[]): Promise<string>;
  /** renderTsx for a checked source (it checks and type-checks again, renders the stills, then the video). */
  render(source: string): Promise<TsxRenderResult>;
  log(line: string): void;
}

export type { TsxRenderResult };
export type AuthorOutcome =
  | { ok: true; source: string; durationInFrames: number; outPath: string; image: string; attempts: number }
  | { ok: false; attempts: number; why: "cap" | "repeat"; step: FeedbackStep; problems: string[] };

const STEP_OF: Record<Exclude<TsxFailureKind, "infra">, FeedbackStep> = {
  check: "check", typecheck: "typecheck", render: "render", timeout: "timeout", preflight: "preflight", output: "output",
};

export async function authorTsx(deps: AuthorDeps, task: TsxTask, maxAttempts: number = TSX_MAX_ATTEMPTS): Promise<AuthorOutcome> {
  const want = targetFrames(task.narrationS);
  const first: Message[] = [{ role: "system", content: tsxSystemPrompt() }, { role: "user", content: tsxUserPrompt(task) }];
  let messages = first;
  let lastSig = "";
  const cap = Math.max(1, Math.min(TSX_MAX_ATTEMPTS, Math.trunc(maxAttempts)));
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
      } else if (frames === undefined || Math.abs(frames - want) > TSX_FRAME_SLACK) {
        step = "timing";
        problems = [`meta: durationInFrames must be ${want} (the narration length); set it to ${want}.`];
      } else {
        const r = await deps.render(source);
        if (r.ok) {
          deps.log(`tsx: attempt ${attempt} of ${cap} rendered`);
          return { ok: true, source, durationInFrames: frames, outPath: r.outPath, image: r.image, attempts: attempt };
        }
        if (r.error.kind === "infra") throw new KnownFailure(r.error.message);
        step = STEP_OF[r.error.kind];
        problems = [r.error.message, ...r.error.problems];
      }
    }
    deps.log(`tsx: attempt ${attempt} of ${cap} failed at ${step}: ${echo(problems[0] ?? "").slice(0, MAX_LOG)} (${problems.length} problem${problems.length === 1 ? "" : "s"})`);
    const sig = `${step}\n${problems.join("\n")}`;
    if (sig === lastSig) return { ok: false, attempts: attempt, why: "repeat", step, problems };
    if (attempt >= cap) return { ok: false, attempts: attempt, why: "cap", step, problems };
    lastSig = sig;
    messages = retryMessages(first, source, step, problems);
  }
}
