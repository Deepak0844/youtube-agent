import path from "node:path";
import { markUsed } from "@/server/db/audio-library";
import type { StageHandler } from "@/server/core/stage-handler";
import { mixPlan } from "@/server/render/mix";
import { copyPromoted, promotedPath, videoIdOf, withAttempt, type AttemptHandler, type FinishDeps } from "./attempt";
import type { StageDeps } from "./deps";

/** Sfx: mixes the sound plan (sfx-plan.json, none = narration only) onto the voiced video as final.mp4. Without `deps.mix` (dry run) it is a copy. */
export function sfxAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    if (!deps.mix) {
      await copyPromoted(deps.root, ctx, "voiced.mp4", "final.mp4");
      return { files: ["final.mp4"], result: { final: "final.mp4" } };
    }
    const id = videoIdOf(ctx);
    const r = await mixPlan(deps.mix, deps.db, ctx, ctx.config.qa, {
      voiced: await promotedPath(deps.root, id, "voiced.mp4"),
      planFile: await promotedPath(deps.root, id, "sfx-plan.json"),
      out: path.join(ctx.attemptDir, "final.mp4"),
    });
    return { files: ["final.mp4", "cue-sheet.txt"], result: { final: "final.mp4", droppedCues: r.droppedCues, usedItems: r.usedItems } };
  };
}

/** The Sfx stage: the attempt, then `used_in` bookkeeping. markUsed runs only after the files were promoted (fenced); a lost or discarded attempt throws before it. */
export function sfxHandler(fin: FinishDeps, deps: StageDeps): StageHandler {
  const inner = withAttempt(fin, sfxAttempt(deps));
  return async (ctx) => {
    const out = (await inner(ctx)) as { usedItems?: string[] };
    for (const item of out.usedItems ?? []) await markUsed(deps.db, item, videoIdOf(ctx));
    return out;
  };
}
