import type { Lang } from "@/server/core/lang";
import type { StageContext } from "@/server/core/stage-handler";

export type TimingsKind = "native" | "aligned" | "estimated" | "none";
export type WordTiming = { word: string; startS: number; endS: number; flags?: string[]; source?: string }; // flags/source: alignment quality marks, when known

export type VoiceCapability = { id: string; wordTimings: TimingsKind; local: boolean; languages: Lang[]; maxChars: number; formats: string[] };

// Narration voice. The real adapters make the provider call inside ctx.paid; the file lands in ctx.attemptDir.
// `none` timings are not allowed for the voice stage (Doc 9 section 1); Task 10 enforces this in the stage.
export interface VoiceProvider {
  capability: VoiceCapability;
  quote(a: { text: string; lang: Lang; voice: string; model?: string }): number;
  synthesise(
    ctx: StageContext,
    a: { text: string; lang: Lang; voice: string; model?: string; settings?: Record<string, string | number> },
  ): Promise<{ audioPath: string; wordTimings: WordTiming[] | null; timingsKind: TimingsKind; priceMicroUsd: number; quoted: boolean }>;
}
