import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { NotProcessedError } from "@/server/core/error-class";
import { LANGS, type Lang } from "@/server/core/lang";
import { isPriced, quote as priceQuote } from "@/server/core/media-catalog";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { escapeXml, isVoiceFor, ttsLocale } from "@/server/core/tts-locales";
import { isMpeg, post, readCapped, type CloudVoiceDeps } from "./cloud-tts";
import type { VoiceProvider } from "./index";

const REGION = /^[a-z0-9-]{3,30}$/;

// The REST endpoint sends no word boundaries; the caller aligns the audio (Task 09).
export function createAzureVoice(deps: CloudVoiceDeps & { region: string }): VoiceProvider {
  function check(a: { lang: Lang; voice: string }) {
    const locale = ttsLocale(a.lang);
    if (!locale) throw new KnownFailure("Azure voices do not support this language.");
    if (!REGION.test(deps.region)) throw new KnownFailure("The Azure region is not valid.");
    if (!isPriced(deps.price) || deps.price.unit !== "per_1k_chars") throw new KnownFailure("Azure has no price set, so it cannot be used.");
    if (!isVoiceFor(locale, a.voice)) throw new KnownFailure("That Azure voice is not known for this language.");
    return { locale, price: deps.price };
  }
  const quote: VoiceProvider["quote"] = (a) => priceQuote(check(a).price, Array.from(a.text).length);

  return {
    capability: { id: "azure_tts", wordTimings: "aligned", local: false, languages: [...LANGS], maxChars: 3500, formats: ["mp3"] },
    quote,
    async synthesise(ctx: StageContext, a) {
      const { locale } = check(a);
      const reserve = quote(a);
      const ssml = `<speak version="1.0" xml:lang="${locale}"><voice name="${a.voice}">${escapeXml(a.text)}</voice></speak>`;
      return ctx.paid({ reserveMicroUsd: reserve, budgetScopes: deps.budgetScopes, kind: "paid" }, async (_callKey, signal) => {
        let key: string;
        try {
          key = await deps.getKey();
        } catch {
          throw new NotProcessedError("The Azure key could not be read.");
        }
        if (!key) throw new NotProcessedError("No Azure key is saved.");
        const res = await post("Azure", deps.fetch, `https://${deps.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
          headers: {
            "Ocp-Apim-Subscription-Key": key,
            "content-type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
            "user-agent": "yt-studio",
          },
          body: ssml,
        }, signal);
        const audio = await readCapped("Azure", res);
        if (!isMpeg(audio)) throw new Error("Azure returned audio that is not MP3."); // empty or wrong body, billed: unknown, parks
        const name = `voice-${createHash("sha256").update(ssml).digest("hex").slice(0, 12)}.mp3`;
        const audioPath = path.join(ctx.attemptDir, name);
        await writeFile(audioPath, audio);
        return { result: { audioPath, wordTimings: null, timingsKind: "aligned" as const, priceMicroUsd: reserve, quoted: true }, actualMicroUsd: reserve };
      });
    },
  };
}
