import type { Lang } from "@/server/core/lang";
import type { StageContext } from "@/server/core/stage-handler";

// Narration voice. The real adapters (Phase 4) make the provider call inside ctx.paid; the file lands in ctx.attemptDir.
export interface VoiceProvider {
  synthesise(
    ctx: StageContext,
    a: { text: string; lang: Lang; voice: string },
  ): Promise<{
    audioPath: string;
    wordTimings: "native" | "aligned" | "estimated" | "none";
    priceMicroUsd: number;
  }>;
}
