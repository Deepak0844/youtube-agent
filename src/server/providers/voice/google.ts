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

const URL_ = "https://texttospeech.googleapis.com/v1/text:synthesize";

// Word marks need the v1beta1 API and a mark per word; not used. The caller aligns the audio (Task 09).
export function createGoogleVoice(deps: CloudVoiceDeps): VoiceProvider {
  // Everything refused before money is reserved or any request is built.
  function check(a: { lang: Lang; voice: string }) {
    const locale = ttsLocale(a.lang);
    if (!locale) throw new KnownFailure("Google voices do not support this language.");
    if (!isPriced(deps.price) || deps.price.unit !== "per_1k_chars") throw new KnownFailure("Google has no price set, so it cannot be used.");
    if (!isVoiceFor(locale, a.voice)) throw new KnownFailure("That Google voice is not known for this language.");
    return { locale, price: deps.price };
  }
  const quote: VoiceProvider["quote"] = (a) => priceQuote(check(a).price, Array.from(a.text).length);

  return {
    capability: { id: "google_tts", wordTimings: "aligned", local: false, languages: [...LANGS], maxChars: 3500, formats: ["mp3"] },
    quote,
    async synthesise(ctx: StageContext, a) {
      const { locale } = check(a);
      const reserve = quote(a);
      const ssml = `<speak>${escapeXml(a.text)}</speak>`;
      return ctx.paid({ reserveMicroUsd: reserve, budgetScopes: deps.budgetScopes, kind: "paid" }, async (_callKey, signal) => {
        let key: string;
        try {
          key = await deps.getKey();
        } catch {
          throw new NotProcessedError("The Google key could not be read.");
        }
        if (!key) throw new NotProcessedError("No Google key is saved.");
        const res = await post("Google", deps.fetch, URL_, {
          headers: { "x-goog-api-key": key, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ input: { ssml }, voice: { languageCode: locale, name: a.voice }, audioConfig: { audioEncoding: "MP3" } }),
        }, signal);
        const body = await readCapped("Google", res);
        let content: unknown;
        try {
          content = (JSON.parse(body.toString("utf8")) as { audioContent?: unknown }).audioContent;
        } catch {
          throw new Error("Google returned an unreadable answer.");
        }
        if (typeof content !== "string" || content === "") throw new Error("Google returned no audio.");
        const audio = Buffer.from(content, "base64");
        if (!isMpeg(audio)) throw new Error("Google returned audio that is not MP3."); // billed: unknown, parks
        const name = `voice-${createHash("sha256").update(`${a.voice}\0${ssml}`).digest("hex").slice(0, 12)}.mp3`;
        const audioPath = path.join(ctx.attemptDir, name);
        await writeFile(audioPath, audio);
        return { result: { audioPath, wordTimings: null, timingsKind: "aligned" as const, priceMicroUsd: reserve, quoted: true }, actualMicroUsd: reserve };
      });
    },
  };
}
