import path from "node:path";
import { copyPromoted, promotedPath, videoIdOf, type AttemptHandler } from "./attempt";
import { contentBody, type StageDeps } from "./deps";
import { muxNarration } from "@/server/render/mix";

/** Voice (mux): puts the narration on the render. Without `deps.mix` (dry run) the render is copied as it is. */
export function voiceAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    if (!deps.mix) {
      await copyPromoted(deps.root, ctx, "render.mp4", "voiced.mp4");
    } else {
      const id = videoIdOf(ctx);
      const n = await contentBody<{ file: string }>(deps.db, id, "narration");
      await muxNarration(deps.mix, ctx, ctx.config.qa, {
        video: await promotedPath(deps.root, id, "render.mp4"),
        voice: await promotedPath(deps.root, id, n.file),
        out: path.join(ctx.attemptDir, "voiced.mp4"),
      });
    }
    return { files: ["voiced.mp4"], result: { muxed: "voiced.mp4" } };
  };
}
