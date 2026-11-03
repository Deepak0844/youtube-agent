import { lstat } from "node:fs/promises";
import { KnownFailure } from "@/server/core/paid-call";
import type { Message } from "@/server/core/agent-loop";
import { reviewRecord } from "@/server/core/frame-review";
import { authorTsx } from "@/server/core/tsx-author";
import { tsxCaptionWords } from "@/server/core/tsx-captions";
import { tooLongForTsx, type PromptBeat, type PromptWord } from "@/server/core/tsx-prompt";
import { approvedScript } from "@/server/db/stage-content";
import { fallBackToSceneKit } from "@/server/db/tsx-fallback";
import type { LlmClient, LlmStageContext } from "@/server/llm/client";
import { promotedPath, type AttemptHandler } from "./attempt";
import { contentBody, loadVideo, videoMoneyScopes, type StageDeps } from "./deps";
import { beatMidFrames, reviewBeats, reviewReady, reviewShots, reviewSlots } from "./frame-review";
import { audioSeconds } from "./voice-audio";

// The reply is one whole file (24 KB at most is about 7,000 tokens); this is the per-attempt output cap. Three attempts at most.
const TSX_MAX_OUTPUT_TOKENS = 8000;

/** One reserved, paid model call per attempt, through the build_tsx route (free-form text). A budget refusal or an unclear outcome goes up as is: the runner parks the stage for the owner. Never retried here. */
export function tsxAsk(llm: LlmClient, ctx: LlmStageContext): (messages: Message[]) => Promise<string> {
  return async (messages) => (await llm.agent(ctx, { stage: "build_tsx", tools: [], messages, maxSteps: 1, maxOutputTokens: TSX_MAX_OUTPUT_TOKENS })).text;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * tsx_author: the code-scene stage. It replaces Build and Render for a video of kind 'tsx', and runs after narration so the
 * word times exist. The model writes one Remotion file; authorTsx checks it, previews it and renders it through renderTsx
 * (the sandboxed path); the accepted source is saved as content `tsx` and render.mp4 goes on to voice, sound and QA unchanged.
 * After the attempt cap (or the same problem twice) the video is switched to the scene kit with an audit event and a note on
 * the video page; the stage then ends cleanly with no files, and the next advance queues Build. Nothing here retries a paid
 * call whose outcome is unclear: that error leaves this function untouched.
 */
export function tsxAuthorAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    // A retry after a crash between the switch and the commit: the video is already a scene-kit video that began as tsx. Done.
    const origin = (await deps.db.query<{ kind_origin: string | null }>("select kind_origin from videos where id = $1", [video.id])).rows[0]?.kind_origin;
    if (video.kind === "scene_kit" && origin === "tsx") return { files: [], result: { fellBack: true, switched: false, resumed: true } };
    if (video.kind !== "tsx") throw new KnownFailure("This video is not a code-scene video.");
    if (!deps.makeLlm) throw new KnownFailure("No scene model is wired, so the code scene cannot be written.");
    if (!deps.tsx) throw new KnownFailure("Code scenes are not set up on this worker.");
    const script = await approvedScript(deps.db, video.id);
    if (!script.ok) throw new KnownFailure(script.reason);

    const narration = await contentBody<{ file?: unknown }>(deps.db, video.id, "narration");
    if (typeof narration.file !== "string") throw new KnownFailure("The narration record has no audio file. Run the voice step again.");
    const audioFile = await promotedPath(deps.root, video.id, narration.file);
    if (!(await lstat(audioFile).catch(() => null))?.isFile()) throw new KnownFailure(`The file ${narration.file} from an earlier stage is missing. Run that stage again.`);
    const captions = await contentBody<{ words?: unknown }>(deps.db, video.id, "captions").catch(() => null);
    const words: PromptWord[] = (Array.isArray(captions?.words) ? captions.words : []).flatMap((w: unknown) => {
      const x = w as { word?: unknown; startS?: unknown; endS?: unknown };
      return typeof x?.word === "string" && typeof x.startS === "number" && typeof x.endS === "number" ? [{ word: x.word, startS: x.startS, endS: x.endS }] : [];
    });
    const lastEnd = words.length > 0 ? Math.max(...words.map((w) => w.endS)) + 0.3 : 0;
    const narrationS = await audioSeconds(deps.mix, ctx, audioFile).catch(() => lastEnd);
    if (!(narrationS > 0)) throw new KnownFailure("The length of the narration is not known. Run the voice step again.");

    // The scene file is capped at 90 s. Narration longer than that is not clipped: the video goes to the scene kit (no such cap).
    if (tooLongForTsx(narrationS)) {
      const switched = await fallBackToSceneKit(deps.db, ctx.claim, video.id, { attempts: 0, step: "length", why: "narration_over_90s" });
      ctx.log(`tsx: the narration is ${narrationS.toFixed(1)} s, over the 90 s limit of a code scene; the video was switched to the scene kit`);
      return { files: [], result: { fellBack: true, switched, attempts: 0, step: "length", why: "narration_over_90s" } };
    }

    const beats: PromptBeat[] = script.beats.map((b, i) => {
      const x = b as { id?: unknown; text?: unknown; visual?: unknown };
      return { id: str(x.id) || `beat-${i + 1}`, text: str(x.text), ...(str(x.visual) ? { visual: str(x.visual) } : {}) };
    });
    const topic = (await deps.db.query<{ topic: string }>("select topic from videos where id = $1", [video.id])).rows[0]?.topic ?? "";

    const llm = deps.makeLlm(await videoMoneyScopes(deps.db, video));
    // Frame review: key frames of each rendered attempt are read by a vision model. With no usable route it is skipped up front
    // (the extra stills are not even rendered) and the reason is logged and stored; it never blocks the video.
    const timed = reviewBeats(beats, words, narrationS);
    const skipped = await reviewReady(llm);
    if (skipped?.status === "skipped") ctx.log(skipped.reason);
    const slots = reviewSlots(ctx);
    const ask = tsxAsk(llm, ctx);
    const out = await authorTsx(
      {
        ask: (m) => {
          slots.beforeAsk();
          return ask(m);
        },
        render: (source, review) => deps.tsx!.renderTsx(ctx, { source, captions: tsxCaptionWords(words), style: video.style, outFile: "render.mp4", ...(review ? { review, reviewAt: beatMidFrames(timed) } : {}) }),
        ...(skipped ? {} : { review: (shots: { frame: number; jpeg: Uint8Array }[]) => reviewShots(llm, slots.reviewCtx, timed, shots, video.style) }),
        log: ctx.log,
      },
      { topic, beats, words, narrationS, style: video.style },
    );

    if (out.ok) {
      const verdict = out.review ?? skipped ?? { status: "unavailable" as const, reason: "frame review unavailable: no frames were reviewed" };
      const record = reviewRecord(verdict, out.attempts);
      return {
        files: ["render.mp4", ...out.stills],
        content: [
          { kind: "tsx", body: { source: out.source, durationInFrames: out.durationInFrames, attempts: out.attempts, image: out.image, stills: out.stills } },
          { kind: "frame_review", body: record },
        ],
        result: { rendered: "render.mp4", attempts: out.attempts, durationInFrames: out.durationInFrames, image: out.image, fellBack: false, frameReview: record },
      };
    }
    const switched = await fallBackToSceneKit(deps.db, ctx.claim, video.id, { attempts: out.attempts, step: out.step, why: out.why });
    ctx.log(`tsx: the code scene could not be made (${out.step} after ${out.attempts} attempt${out.attempts === 1 ? "" : "s"}); the video was switched to the scene kit`);
    return { files: [], result: { fellBack: true, switched, attempts: out.attempts, step: out.step, why: out.why, ...(out.review ? { frameReview: reviewRecord(out.review, out.attempts) } : {}) } };
  };
}
