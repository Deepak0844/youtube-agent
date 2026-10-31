import type { StageContext } from "@/server/core/stage-handler";
import type { SceneDoc } from "@/shared/scene";

export interface RenderArgs {
  /** The promoted scene file. The fake renderer only checks the call; the container renderer renders `doc`. */
  sceneFile: string;
  /** The validated scene document (scenes.json). Required by the container renderer. */
  doc?: SceneDoc;
  /** The promoted narration audio. */
  audioFile?: string;
  /** Stored caption words ({word, startS, endS, ...}) from the `captions` content. */
  captions?: unknown[];
  /** A plain file name, never a path. */
  outFile: string;
  size: { width: number; height: number };
}

// Turns a scene document into an mp4 inside ctx.attemptDir.
export interface Renderer {
  /** `image`: what ran (the render image id when pinned). */
  render(ctx: StageContext, a: RenderArgs): Promise<{ outPath: string; image?: string }>;
}
