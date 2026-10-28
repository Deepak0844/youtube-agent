import { copyPromoted, type AttemptHandler } from "./attempt";
import type { StageDeps } from "./deps";

/** Sfx: adds sound effects. Dry run: a copy of the muxed video, named final.mp4. */
export function sfxAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    await copyPromoted(deps.root, ctx, "voiced.mp4", "final.mp4");
    return { files: ["final.mp4"], result: { final: "final.mp4" } };
  };
}
