import type { StageContext } from "@/server/core/stage-handler";
import type { SceneDoc } from "@/shared/scene";
import type { Scale3dScene } from "@/shared/scale3d";

// The TSX path (ADR 0009): called by the tsx_author stage (src/worker/stages/tsx-author.ts).
export type { TsxRenderer, TsxRenderInput, TsxRenderResult, TsxRenderFailure, TsxFailureKind } from "./tsx-render";

export interface RenderArgs {
  /** The promoted scene file. The fake renderer only checks the call; the container renderer renders `doc`. */
  sceneFile: string;
  /** The validated scene document (scenes.json). Required by the container renderer. */
  doc?: SceneDoc;
  /** A checked 3D scale description (already re-timed to the narration). The container renderer then renders the `scale3d` composition instead of `doc`. */
  scale3d?: Scale3dScene;
  /** The promoted narration audio. */
  audioFile?: string;
  /** Stored caption words ({word, startS, endS, ...}) from the `captions` content. */
  captions?: unknown[];
  /** The video id (picks the palette) and a title for the opening card. Optional: old callers still render. */
  videoId?: string;
  title?: string;
  /** Chosen look and caption layer; null or absent = the default look. */
  style?: string | null;
  captionStyle?: string | null;
  /** A plain file name, never a path. */
  outFile: string;
  size: { width: number; height: number };
}

// Turns a scene document into an mp4 inside ctx.attemptDir.
export interface Renderer {
  /** `image`: what ran (the render image id when pinned). */
  render(ctx: StageContext, a: RenderArgs): Promise<{ outPath: string; image?: string }>;
}
