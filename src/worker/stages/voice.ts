import { writeFile } from "node:fs/promises";
import path from "node:path";
import { tsxCaptionsAss } from "@/server/core/tsx-captions";
import { burnCaptions, muxNarration } from "@/server/render/mix";
import { copyPromoted, promotedPath, videoIdOf, type AttemptHandler } from "./attempt";
import { contentBody, loadVideo, type StageDeps } from "./deps";

/**
 * Voice (mux): puts the narration on the render. Without `deps.mix` (dry run) the render is copied as it is.
 * A custom-animation (tsx) video draws no subtitles of its own, so word-synced captions are burned in first (tsx-captions.ts).
 * That is best effort: if ffmpeg cannot do it the video is finished without captions and the result says "captions: none".
 */
export function voiceAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    let captions: "burned" | "none" | undefined;
    if (!deps.mix) {
      await copyPromoted(deps.root, ctx, "render.mp4", "voiced.mp4");
    } else {
      const id = videoIdOf(ctx);
      const n = await contentBody<{ file: string }>(deps.db, id, "narration");
      let video = await promotedPath(deps.root, id, "render.mp4");
      if ((await loadVideo(deps.db, ctx)).kind === "tsx") {
        captions = "none";
        try {
          const c = await contentBody<{ words?: unknown }>(deps.db, id, "captions");
          const ass = tsxCaptionsAss(Array.isArray(c.words) ? (c.words as { word: string; startS: number; endS: number }[]) : []);
          if (ass) {
            await writeFile(path.join(ctx.attemptDir, "captions.ass"), ass, { mode: 0o644 });
            await burnCaptions(deps.mix, ctx, { video, ass: "captions.ass", out: path.join(ctx.attemptDir, "captioned.mp4") });
            video = path.join(ctx.attemptDir, "captioned.mp4");
            captions = "burned";
          }
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          ctx.log("voice: captions could not be burned in, the video has none");
        }
      }
      await muxNarration(deps.mix, ctx, ctx.config.qa, {
        video,
        voice: await promotedPath(deps.root, id, n.file),
        out: path.join(ctx.attemptDir, "voiced.mp4"),
      });
    }
    return { files: ["voiced.mp4"], result: { muxed: "voiced.mp4", ...(captions ? { captions } : {}) } };
  };
}
