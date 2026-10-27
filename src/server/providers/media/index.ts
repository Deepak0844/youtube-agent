import type { StageContext } from "@/server/core/stage-handler";

// Still-image generation. The file lands in ctx.attemptDir.
export interface ImageProvider {
  generate(ctx: StageContext, a: { prompt: string; size: { width: number; height: number } }): Promise<{ imagePath: string; priceMicroUsd: number }>;
}
