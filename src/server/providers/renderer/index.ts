import type { StageContext } from "@/server/core/stage-handler";

// Turns a scene file into an mp4 inside ctx.attemptDir. outFile is a plain file name, never a path.
export interface Renderer {
  render(ctx: StageContext, a: { sceneFile: string; outFile: string; size: { width: number; height: number } }): Promise<{ outPath: string }>;
}
