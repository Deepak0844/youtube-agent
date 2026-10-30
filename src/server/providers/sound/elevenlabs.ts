import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { NotProcessedError } from "@/server/core/error-class";
import { isPriced, quote as priceQuote, type PriceRule } from "@/server/core/media-catalog";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import type { MediaArtifact } from "../media-types";
import type { SafeFetch } from "../voice/eleven-types";
import { elevenPost, isMpeg, readCapped } from "../voice/elevenlabs";
import { cleanPrompt, MAX_PROMPT, type SoundProvider } from "./index";

export interface ElevenLabsSoundDeps {
  fetch: SafeFetch;
  /** Decrypted per call; never cached or logged. */
  getKey: () => Promise<string>;
  /** The `elevenlabs_sfx` / `elevenlabs_music` registry prices; null = unpriced, refused. */
  sfxPrice: PriceRule | null;
  musicPrice: PriceRule | null;
  budgetScopes: string[];
}

export const GENERATED_LICENCE = "generated with ElevenLabs under the owner's plan; check plan terms for commercial use";
const SFX_MODEL = "eleven_text_to_sound_v2";
const MUSIC_MODEL = "music_v2";
const RANGE = { sfx: [0.5, 30], music: [3, 600] } as const; // seconds the endpoints accept

type Kind = "sfx" | "music";

export function createElevenLabsSound(deps: ElevenLabsSoundDeps): SoundProvider {
  // Everything refused before money is reserved or any request is built.
  function check(kind: Kind, a: { prompt: string; seconds: number }) {
    const price = kind === "sfx" ? deps.sfxPrice : deps.musicPrice;
    if (!isPriced(price) || price.unit !== "per_second") throw new KnownFailure(`ElevenLabs ${kind === "sfx" ? "sound effects have" : "music has"} no price set, so it cannot be used.`);
    if (cleanPrompt(a.prompt) === null) throw new KnownFailure(`A sound needs a description of 1 to ${MAX_PROMPT} characters.`);
    const [lo, hi] = RANGE[kind];
    if (!Number.isFinite(a.seconds) || a.seconds < lo || a.seconds > hi) throw new KnownFailure(`A ${kind === "sfx" ? "sound effect" : "music track"} must be ${lo} to ${hi} seconds long.`);
    return price;
  }
  // Sound effects, duration_seconds always set. ElevenLabs docs disagree: the API reference says 20 credits/s, the overview page says 40 credits/s
  // (https://elevenlabs.io/docs/api-reference/sound-generation). A live 2 s clip used 20 credits = 10 credits/s, the LOW data point.
  // So reserve the WORST documented rate: 40 credits/s. ASSUMPTION: 1 credit = $0.0001 (the registry's $0.12/min = 2000 micro-USD/s is 20 credits/s),
  // so 40 credits/s = 4000 micro-USD/s = 2 x the registry per-second price.
  // The response has no credit count, so recorded spend = this quote: an ESTIMATE (provenance quoted: true) that fails safe, overstating the
  // real 10-20 credits/s by 2-4x, until an owner smoke measures real credits. Music is unconfirmed ("billed per generation"): whole-minute over-quote.
  const quote = (kind: Kind, a: { prompt: string; seconds: number }) => priceQuote(check(kind, a), kind === "sfx" ? a.seconds * 2 : Math.ceil(a.seconds / 60) * 60);

  async function make(kind: Kind, ctx: StageContext, raw: { prompt: string; seconds: number }): Promise<MediaArtifact> {
    const a = { ...raw, prompt: cleanPrompt(raw.prompt) ?? "" }; // check() inside quote() has refused an unusable prompt
    const reserve = quote(kind, a);
    const model = kind === "sfx" ? SFX_MODEL : MUSIC_MODEL;
    const [url, body] = kind === "sfx"
      ? ["/v1/sound-generation?output_format=mp3_44100_128", { text: a.prompt, duration_seconds: a.seconds, model_id: model }]
      : ["/v1/music?output_format=mp3_44100_128", { prompt: a.prompt, music_length_ms: Math.round(a.seconds * 1000), model_id: model, force_instrumental: true }];
    return ctx.paid({ reserveMicroUsd: reserve, budgetScopes: deps.budgetScopes, kind: "paid" }, async (_callKey, signal) => {
      let key: string;
      try {
        key = await deps.getKey();
      } catch {
        throw new NotProcessedError("The ElevenLabs key could not be read.");
      }
      if (!key) throw new NotProcessedError("No ElevenLabs key is saved.");
      let res: Response;
      try {
        res = await elevenPost(deps.fetch, key, signal, url, body, "audio/mpeg");
      } catch (err) {
        // The free plan has no music API: say so plainly instead of "refused (402)".
        if (kind === "music" && err instanceof NotProcessedError && (err.status === 402 || err.status === 403)) throw new NotProcessedError("Music generation is not available on this ElevenLabs plan.", { status: err.status });
        throw err;
      }
      const audio = await readCapped(res); // a reset or truncated body throws: outcome unknown
      if (!isMpeg(audio)) throw new Error("ElevenLabs returned audio that is not MP3."); // billed: unknown, parks
      const sha256 = createHash("sha256").update(audio).digest("hex");
      const file = path.join(ctx.attemptDir, `${kind}-${createHash("sha256").update(`${model}\0${a.seconds}\0${a.prompt}`).digest("hex").slice(0, 12)}.mp3`);
      await writeFile(file, audio);
      const result: MediaArtifact = {
        path: file, bytes: audio.length, sha256,
        provenance: { provider: kind === "sfx" ? "elevenlabs_sfx" : "elevenlabs_music", model, params: { prompt: a.prompt, seconds: a.seconds, ...(kind === "music" ? { instrumental: true } : {}) }, priceMicroUsd: reserve, quoted: true, licence: GENERATED_LICENCE },
      };
      return { result, actualMicroUsd: reserve };
    });
  }

  return {
    quoteSfx: (a) => quote("sfx", a),
    quoteMusic: (a) => quote("music", a),
    makeSfx: (ctx, a) => make("sfx", ctx, a),
    makeMusic: (ctx, a) => make("music", ctx, a),
  };
}
