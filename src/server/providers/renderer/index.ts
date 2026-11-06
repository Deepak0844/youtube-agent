import type { StageContext } from "@/server/core/stage-handler";
import type { SceneDoc } from "@/shared/scene";
import type { Scale3dScene } from "@/shared/scale3d";
import type { Scene3d } from "@/shared/scene3d";
import type { SceneProps } from "@/server/core/scene3d-code-body";

// The TSX path (ADR 0009): called by the tsx_author stage (src/worker/stages/tsx-author.ts).
export type { TsxRenderer, TsxRenderInput, TsxRenderResult, TsxRenderFailure, TsxFailureKind } from "./tsx-render";

export interface RenderArgs {
  /** The promoted scene file. The fake renderer only checks the call; the container renderer renders `doc`. */
  sceneFile: string;
  /** The validated scene document (scenes.json). Required by the container renderer. */
  doc?: SceneDoc;
  /** A checked 3D scale description (already re-timed to the narration). The container renderer then renders the `scale3d` composition instead of `doc`. */
  scale3d?: Scale3dScene;
  /** A checked 3D scene (scene format v2, already re-timed to the narration). Rendered by the NATIVE renderer only, composition `scene3d`. */
  scene3d?: Scene3d;
  /** An AI-written 3D scene (scene3d_code): its source, the host-built props and the fingerprint the owner approved. Rendered by the NATIVE renderer only, composition `s3k-author`. */
  scene3dCode?: Scene3dCodeInput;
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

/** What the native renderer needs to draw an AI-written scene. `expectedSha256` is sceneCodeSha(source, props) as approved; the renderer refuses any difference. */
export interface Scene3dCodeInput {
  source: string;
  props: SceneProps;
  expectedSha256: string;
}

export interface Scene3dStillsArgs {
  /** A checked 3D scene (already re-timed to the narration). Exactly one of scene3d and scene3dCode is given. */
  scene3d?: Scene3d;
  scene3dCode?: Scene3dCodeInput;
  /** 1 to 8 whole frame numbers inside the video. */
  frames: number[];
}
/** Draws a few frames of a 3D scene as 540x960 PNGs (native renderer only). */
export interface Scene3dStillsRenderer {
  /** Writes <attemptDir>/stills/01.png ... and returns those names (relative to the attempt folder). */
  stills(ctx: StageContext, a: Scene3dStillsArgs): Promise<{ files: string[]; image?: string }>;
}

// Turns a scene document into an mp4 inside ctx.attemptDir.
export interface Renderer {
  /** `image`: what ran (the render image id when pinned). */
  render(ctx: StageContext, a: RenderArgs): Promise<{ outPath: string; image?: string }>;
}
