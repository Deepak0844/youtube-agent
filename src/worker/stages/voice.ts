import { copyPromoted, type AttemptHandler } from "./attempt";
import type { StageDeps } from "./deps";

/** Voice (mux): puts the narration on the render. Dry run: no real mixing, the render is copied as it is. */
export function voiceAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    await copyPromoted(deps.root, ctx, "render.mp4", "voiced.mp4");
    return { files: ["voiced.mp4"], result: { muxed: "voiced.mp4" } };
  };
}
