import type { StageContext } from "@/server/core/stage-handler";
import type { MediaArtifact } from "../media-types";

export type Aspect = "9:16" | "16:9" | "1:1";

// Still-image generation. The adapter reserves the money itself (ctx.paid); `budgetScopes` (e.g. a video's quote cap) are required: with none the call is refused. The image and its sidecar JSON land in ctx.attemptDir. `refs` are asset ids the adapter's caller can resolve to files.
export interface ImageProvider {
  capability: { id: string; refImages: boolean; seed: boolean; aspects: Aspect[]; maxRefs: number };
  /** Micro-USD for one image; refuses (KnownFailure) when unpriced or the arguments are unusable. */
  quote(a: { aspect: Aspect; refs: number; model: string }): number;
  generate(ctx: StageContext, a: { prompt: string; aspect: Aspect; refs?: string[]; seed?: number; model: string; budgetScopes: string[] }): Promise<MediaArtifact>;
}
