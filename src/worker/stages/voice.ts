import path from "node:path";
import { tsxCaptionsStatus } from "@/server/core/tsx-captions";
import { muxNarration } from "@/server/render/mix";
import { copyPromoted, promotedPath, videoIdOf, type AttemptHandler } from "./attempt";
import { contentBody, loadVideo, type StageDeps } from "./deps";

/**
 * Voice (mux): puts the narration on the render. Without `deps.mix` (dry run) the render is copied as it is.
 * A custom-animation (tsx) video gets its captions drawn inside the render (tsx-root.tsx); this step only reports whether that
 * happened: result.captions is "in_render" or "none (why)", and a "none" is logged.
 */
export function voiceAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    let captions: string | undefined;
    if (!deps.mix) {
      await copyPromoted(deps.root, ctx, "render.mp4", "voiced.mp4");
    } else {
      const id = videoIdOf(ctx);
      const n = await contentBody<{ file: string }>(deps.db, id, "narration");
      if ((await loadVideo(deps.db, ctx)).kind === "tsx") {
        const c = await contentBody<{ words?: unknown }>(deps.db, id, "captions").catch(() => null);
        captions = tsxCaptionsStatus(Array.isArray(c?.words) ? c.words : undefined);
        if (captions !== "in_render") ctx.log(`voice: this video has no captions: ${captions}`);
      }
      await muxNarration(deps.mix, ctx, ctx.config.qa, {
        video: await promotedPath(deps.root, id, "render.mp4"),
        voice: await promotedPath(deps.root, id, n.file),
        out: path.join(ctx.attemptDir, "voiced.mp4"),
      });
    }
    return { files: ["voiced.mp4"], result: { muxed: "voiced.mp4", ...(captions ? { captions } : {}) } };
  };
}
