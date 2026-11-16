import type { StageContext } from "@/server/core/stage-handler";
import type { MediaArtifact } from "../media-types";

export interface SoundProvider {
  quoteSfx(a: { prompt: string; seconds: number }): number;
  makeSfx(ctx: StageContext, a: { prompt: string; seconds: number }): Promise<MediaArtifact>;
  quoteMusic(a: { prompt: string; seconds: number }): number;
  makeMusic(ctx: StageContext, a: { prompt: string; seconds: number }): Promise<MediaArtifact>;
}

export const MAX_PROMPT = 500;
/** Plain text: control characters removed and trimmed; null when empty or over 500 code points. */
export function cleanPrompt(raw: string): string | null {
  const t = raw.replace(/\p{Cc}/gu, "").trim();
  return t === "" || Array.from(t).length > MAX_PROMPT ? null : t;
}
