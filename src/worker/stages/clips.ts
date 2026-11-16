import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { planBatch, reviewBatch, type ClipBatchBody, type Measured } from "@/server/core/clip-batch";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { renderClip, type ClipRenderInput, type ClipRenderResult } from "@/server/providers/renderer/clip-render";
import { cutClipFile, durationS } from "@/server/render/mix";
import { promotedPath, type AttemptHandler } from "./attempt";
import { contentBody, loadVideo, type StageDeps } from "./deps";

export interface ClipsOverrides {
  /** Test seam. Default: renderClip through the locked renderer (deps.tsxDeps). */
  render?: (ctx: StageContext, input: ClipRenderInput) => Promise<ClipRenderResult>;
}

export type { ClipBatchBody };
export const CLIP_MAX_S = 58;
export const CLIP_MIN_S = 15;
export const CLIP_MAX_SHARE = 0.7;

const isWord = (w: unknown): w is { word: string; startS: number; endS: number } =>
  typeof w === "object" && w !== null && typeof (w as { word?: unknown }).word === "string" && Number.isFinite((w as { startS?: unknown }).startS) && Number.isFinite((w as { endS?: unknown }).endS);

/**
 * On demand (never in the route, not in the hash chain): cuts a batch of short clips out of a FINISHED video and puts the app's captions on
 * them. Free and local: no model, no voice, no money. Steps per clip: cut and reframe to 1080x1920 (ffmpeg, child runner), captions in the
 * locked renderer, loudness scan. Then the CF3a checks (hook, loudness, captions) run on every clip and the whole batch is saved as a new
 * `clip_batch` version of the source video. A clip with a warning stays in the batch: the owner decides at the gate (CF4b). Nothing here
 * publishes or approves anything; the clip files are kept next to the source video's own files.
 */
export function clipsAttempt(deps: StageDeps, o: ClipsOverrides = {}): AttemptHandler {
  return async (ctx) => {
    if (!deps.mix) throw new KnownFailure("No video tool is wired, so clips cannot be cut.");
    const tsxDeps = deps.tsxDeps;
    const render = o.render ?? (tsxDeps ? (c: StageContext, i: ClipRenderInput) => renderClip(tsxDeps, c, i) : undefined);
    if (!render) throw new KnownFailure("The locked renderer is not set up on this worker, so clips cannot be made.");
    if (!deps.qaScan) throw new KnownFailure("The video scan is not wired, so clip loudness cannot be measured.");
    const video = await loadVideo(deps.db, ctx);
    const caps = await contentBody<{ words?: unknown }>(deps.db, video.id, "captions").catch(() => null);
    const words = Array.isArray(caps?.words) ? caps.words.filter(isWord) : [];
    if (words.length === 0) throw new KnownFailure("This video has no caption words, so there is nothing to cut clips by.");
    const source = await promotedPath(deps.root, video.id, "final.mp4");
    const sourceS = await durationS(deps.mix, ctx, source);

    // A clip becomes a Short and a Short's QA allows at most 60 s (qa.short.maxS), so no clip is planned longer than 58 s. A clip is also
    // never more than 70% of the source: a longer one is a near-copy of the video, not a cut from it (owner decision 2026-11-16).
    const maxS = Math.min(CLIP_MAX_S, sourceS * CLIP_MAX_SHARE);
    if (maxS < CLIP_MIN_S) throw new KnownFailure(`This video is only ${Math.round(sourceS)} s long, too short to cut clips from: a clip is at least ${CLIP_MIN_S} s and at most ${Math.round(CLIP_MAX_SHARE * 100)}% of the video. Use a video of about ${Math.ceil(CLIP_MIN_S / CLIP_MAX_SHARE)} s or more.`);
    const plan = planBatch(words, { maxS });
    if (!plan.ok) throw new KnownFailure(plan.reason);
    const prev = await deps.db.query<{ n: string }>("select count(*)::text as n from video_content where video_id = $1 and kind = 'clip_batch'", [video.id]);
    const batch = Number(prev.rows[0]!.n) + 1;

    const clips: ClipBatchBody["clips"] = [];
    const measured: Record<string, Measured> = {};
    const files: string[] = [];
    for (const c of plan.clips) {
      const endS = Math.min(c.endS, sourceS); // a cut never runs past the end of the video
      if (endS - c.startS < 1) {
        ctx.log(`clips: ${c.id} starts past the end of the video, skipped`);
        continue;
      }
      const cut = path.join(ctx.attemptDir, `cut-${c.id}.mp4`);
      const outName = `clips-b${batch}-${c.id}.mp4`;
      const cutS = await cutClipFile(deps.mix, ctx, { inFile: source, outFile: cut, startS: c.startS, endS });
      const done = await render(ctx, { clipFile: cut, captions: c.words, style: video.style, durationS: cutS, outFile: outName });
      await rm(cut, { force: true });
      if (!done.ok) throw new KnownFailure(`Clip ${c.id}: ${done.message}`);
      const scanDir = path.join(ctx.attemptDir, `scan-${c.id}`);
      await mkdir(scanDir, { recursive: true });
      const scan = await deps.qaScan(done.outPath, ctx.signal, { storageRoot: deps.root, attemptDir: scanDir });
      await rm(scanDir, { recursive: true, force: true });
      measured[c.id] = { lufs: scan.lufs, truePeakDb: scan.truePeakDb };
      clips.push({ ...c, endS, durationS: Math.round(cutS * 1000) / 1000, file: outName });
      files.push(outName);
      ctx.log(`clips: ${c.id} done (${cutS.toFixed(1)} s)`);
    }
    if (clips.length === 0) throw new KnownFailure("No clip could be cut from this video.");
    const review = reviewBatch(clips, measured);
    const body: ClipBatchBody = { sourceVideoId: video.id, batch, clips, measured, review };
    return { files, content: [{ kind: "clip_batch", body }], result: { batch, clips: clips.length, needAttention: review.needAttention } };
  };
}
