import { createHash } from "node:crypto";
import path from "node:path";
import { LANGS } from "@/server/core/lang";
import type { StageContext } from "@/server/core/stage-handler";
import { postJson, requireScopes, saveCapped } from "./local-http";
import type { TimingsKind, VoiceProvider } from "./index";

export interface OpenAiCompatibleCfg {
  baseUrl: string;
  localServices: readonly string[];
  model: string;
  voice: string;
  getKey?: () => Promise<string | null>;
  budgetScopes: string[];
  wordTimings: Extract<TimingsKind, "native" | "aligned" | "estimated">;
}

/** Any local server with POST /v1/audio/speech. Free. The audio carries no times: the voice stage aligns or estimates them. */
export function createOpenAiCompatibleVoice(cfg: OpenAiCompatibleCfg): VoiceProvider {
  const budgetScopes = requireScopes(cfg.budgetScopes, "The local voice");
  return {
    capability: { id: "openai-compatible", wordTimings: cfg.wordTimings, local: true, languages: [...LANGS], maxChars: 4096, formats: ["wav"] },
    quote: () => 0,
    async synthesise(ctx: StageContext, a) {
      const audioPath = path.join(ctx.attemptDir, `voice-${createHash("sha256").update(`${a.lang}\0${a.voice}\0${a.text}`).digest("hex").slice(0, 12)}.wav`);
      const url = `${cfg.baseUrl.replace(/\/+$/, "")}/v1/audio/speech`;
      const body = JSON.stringify({ model: a.model ?? cfg.model, voice: a.voice || cfg.voice, input: a.text, response_format: "wav" });
      await ctx.paid({ reserveMicroUsd: 0, budgetScopes, kind: "paid" }, async (_key, signal) => {
        await saveCapped(await postJson(url, body, cfg, signal), audioPath);
        return { result: null, actualMicroUsd: 0 };
      });
      return { audioPath, wordTimings: null, timingsKind: cfg.wordTimings, priceMicroUsd: 0, quoted: true };
    },
  };
}
