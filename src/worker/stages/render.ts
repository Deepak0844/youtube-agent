import { lstat } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { promotedPath, type AttemptHandler } from "./attempt";
import { contentBody, loadVideo, SIZE, type StageDeps } from "./deps";

/**
 * Render: the renderer turns the scene file into render.mp4. It reads only promoted files and writes only into its attempt
 * folder. A slot in the render semaphore is taken by the dispatcher (handlers.ts), not here.
 */
export function renderAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    const narration = await contentBody<{ file?: unknown }>(deps.db, video.id, "narration");
    if (typeof narration.file !== "string") throw new KnownFailure("The narration record has no audio file. Run the voice step again.");
    for (const name of ["scene.json", narration.file]) {
      const st = await lstat(await promotedPath(deps.root, video.id, name)).catch(() => null);
      if (!st?.isFile()) throw new KnownFailure(`The file ${name} from an earlier stage is missing. Run that stage again.`);
    }
    const r = await deps.renderer.render(ctx, { sceneFile: await promotedPath(deps.root, video.id, "scene.json"), outFile: "render.mp4", size: SIZE });
    if (path.dirname(path.resolve(r.outPath)) !== path.resolve(ctx.attemptDir)) throw new KnownFailure("The renderer wrote outside its attempt folder.");
    return { files: ["render.mp4"], result: { rendered: "render.mp4" } };
  };
}
