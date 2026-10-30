import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { parsePalette } from "@/server/core/sfx-palette";
import { planFromCueSheet } from "@/server/core/sfx-plan";
import { findLibraryFirst, markUsed } from "@/server/db/audio-library";
import type { StageHandler } from "@/server/core/stage-handler";
import { mixPlan } from "@/server/render/mix";
import { copyPromoted, promotedPath, videoIdOf, withAttempt, type AttemptHandler, type FinishDeps } from "./attempt";
import type { StageDeps } from "./deps";

const readIfThere = (file: string) => readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });

/** No sfx-plan.json but an sfx-cues.json (recipe ids + times): turn it into a plan from the free library only (never a paid clip). Returns the plan file to mix. */
async function planFile(deps: StageDeps, ctx: Parameters<AttemptHandler>[0], id: string, audioRoot: string): Promise<string> {
  const plan = await promotedPath(deps.root, id, "sfx-plan.json"); // an existing sfx-plan.json wins over sfx-cues.json
  const cues = await readIfThere(await promotedPath(deps.root, id, "sfx-cues.json"));
  if (cues === null || (await readIfThere(plan)) !== null) return plan;
  const pal = await readIfThere(path.join(audioRoot, "sfx", "palette.json"));
  if (pal === null) throw new KnownFailure("The sound cue sheet needs the sound palette (audio/sfx/palette.json), and it is missing.");
  const out = path.join(ctx.attemptDir, "sfx-plan.json");
  let dbError: unknown; // a failed library lookup is transient: it propagates, only a bad sheet or palette is a known failure
  try {
    const built = await planFromCueSheet(JSON.parse(cues), parsePalette("sfx", JSON.parse(pal)), async (tags) => {
      try {
        return (await findLibraryFirst(deps.db, { kind: "sfx", tags }))[0]?.id;
      } catch (e) {
        dbError = e;
        throw e;
      }
    });
    await writeFile(out, JSON.stringify(built));
  } catch (e) {
    if (dbError !== undefined && e === dbError) throw e;
    throw new KnownFailure(`The sound cue sheet could not be used: ${e instanceof Error ? e.message : "not valid"}`);
  }
  return out;
}

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
      planFile: await planFile(deps, ctx, id, deps.mix.audioRoot),
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
