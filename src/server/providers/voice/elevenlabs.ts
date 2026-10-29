import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isPriced, quote as priceQuote } from "@/server/core/media-catalog";
import { NotProcessedError } from "@/server/core/error-class";
import { KnownFailure } from "@/server/core/paid-call";
import { LANGS } from "@/server/core/lang";
import type { StageContext } from "@/server/core/stage-handler";
import { BlockedAddressError } from "../net/safe-fetch";
import { MODELS, type Alignment, type ElevenLabsDeps } from "./eleven-types";
import type { VoiceProvider, WordTiming } from "./index";

const HOST = "https://api.elevenlabs.io";
const MAX_BODY = 50 * 1024 * 1024;
const MAX_TAG = 80;
const BEFORE_SEND = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** Plain text before the line: control characters removed, at most 80 code points. */
function tagPrefix(raw: string | undefined): string {
  return Array.from((raw ?? "").replace(/\p{Cc}/gu, "").trim()).slice(0, MAX_TAG).join("");
}

/** Character times to word times: words split on whitespace (works for Indic scripts, no spaces inside a word). */
export function foldWords(a: Alignment): WordTiming[] {
  const out: WordTiming[] = [];
  let cur: WordTiming | null = null;
  a.characters.forEach((ch, i) => {
    if (ch.trim() === "") {
      cur = null;
      return;
    }
    const start = a.character_start_times_seconds[i]!;
    const end = a.character_end_times_seconds[i]!;
    if (cur) {
      cur.word += ch;
      cur.endS = end;
    } else {
      cur = { word: ch, startS: start, endS: end };
      out.push(cur);
    }
  });
  return out;
}

function parseAlignment(v: unknown): Alignment {
  const a = v as Alignment | null;
  const ok =
    !!a && Array.isArray(a.characters) && Array.isArray(a.character_start_times_seconds) && Array.isArray(a.character_end_times_seconds) &&
    a.characters.length === a.character_start_times_seconds.length && a.characters.length === a.character_end_times_seconds.length &&
    a.characters.every((c) => typeof c === "string") &&
    a.character_start_times_seconds.every(Number.isFinite) && a.character_end_times_seconds.every(Number.isFinite);
  if (!ok) throw new Error("ElevenLabs returned timings in an unexpected shape.");
  return a;
}

async function readCapped(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_BODY) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("ElevenLabs response is over the 50 MB limit.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new Error("ElevenLabs sent no body.");
  for (;;) {
    const { done, value } = await reader.read(); // a reset or truncated body throws here: outcome unknown
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      throw new Error("ElevenLabs response is over the 50 MB limit.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function createElevenLabsVoice(deps: ElevenLabsDeps): VoiceProvider {
  const prefix = tagPrefix(deps.tags?.prefix);
  const sent = (text: string) => (prefix ? `${prefix} ${text}` : text);

  // Everything refused before money is reserved or any request is built.
  function check(a: { voice: string; model?: string }) {
    const model = a.model ?? deps.model;
    if (!MODELS.has(model)) throw new KnownFailure(`ElevenLabs model "${model.slice(0, 60)}" is not supported.`);
    if (!isPriced(deps.price) || deps.price.unit !== "per_1k_chars") throw new KnownFailure("ElevenLabs has no price set, so it cannot be used.");
    const voice = a.voice || deps.voiceId;
    if (!/^[A-Za-z0-9]{1,64}$/.test(voice)) throw new KnownFailure("The ElevenLabs voice id is not valid.");
    return { model, voice, price: deps.price };
  }

  const quote: VoiceProvider["quote"] = (a) => {
    const { price } = check(a);
    return priceQuote(price, Array.from(sent(a.text)).length);
  };

  async function request(key: string, signal: AbortSignal, model: string, voice: string, text: string): Promise<Response> {
    let res: Response;
    try {
      res = await deps.fetch(`${HOST}/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ text, model_id: model }),
        redirect: "manual",
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw signal.reason; // cancel/timeout after send: unknown
      if (err instanceof BlockedAddressError) throw new NotProcessedError("ElevenLabs address was blocked.");
      const code = (err as { cause?: { code?: unknown } })?.cause?.code;
      if (typeof code === "string" && BEFORE_SEND.has(code)) throw new NotProcessedError("ElevenLabs could not be reached.", { code });
      throw new Error("ElevenLabs request failed after it was sent."); // fixed text: no cause, no URL, no key
    }
    if (res.ok) return res;
    await res.body?.cancel().catch(() => undefined);
    // 4xx = rejected before work (429 retried by the classifier, the rest permanent). 5xx may follow started work: unknown.
    if (res.status >= 400 && res.status <= 499) throw new NotProcessedError(`ElevenLabs refused the request (${res.status}).`, { status: res.status });
    throw new Error(`ElevenLabs answered ${res.status}; the outcome is unknown.`);
  }

  return {
    capability: { id: "elevenlabs", wordTimings: "native", local: false, languages: [...LANGS], maxChars: 3500, formats: ["mp3"] },
    quote,
    async synthesise(ctx: StageContext, a) {
      const { model, voice } = check(a);
      const reserve = quote(a);
      const text = sent(a.text);
      return ctx.paid({ reserveMicroUsd: reserve, budgetScopes: deps.budgetScopes, kind: "paid" }, async (_callKey, signal) => {
        let key: string;
        try {
          key = await deps.getKey();
        } catch {
          throw new NotProcessedError("The ElevenLabs key could not be read.");
        }
        if (!key) throw new NotProcessedError("No ElevenLabs key is saved.");
        const res = await request(key, signal, model, voice, text);
        const body = await readCapped(res);
        const json = JSON.parse(body.toString("utf8")) as { audio_base64?: unknown; alignment?: unknown };
        if (typeof json.audio_base64 !== "string") throw new Error("ElevenLabs returned no audio.");
        const audio = Buffer.from(json.audio_base64, "base64");
        let words = foldWords(parseAlignment(json.alignment));
        const tagWords = prefix.split(/\s+/u).filter(Boolean);
        if (tagWords.length > 0 && tagWords.every((w, i) => words[i]?.word === w)) words = words.slice(tagWords.length);
        const name = `voice-${createHash("sha256").update(`${voice}\0${model}\0${text}`).digest("hex").slice(0, 12)}.mp3`;
        const audioPath = path.join(ctx.attemptDir, name);
        await writeFile(audioPath, audio);
        return { result: { audioPath, wordTimings: words, timingsKind: "native" as const, priceMicroUsd: reserve, quoted: true }, actualMicroUsd: reserve };
      });
    },
  };
}
