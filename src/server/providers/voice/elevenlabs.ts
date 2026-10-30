import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isPriced, quote as priceQuote } from "@/server/core/media-catalog";
import { NotProcessedError } from "@/server/core/error-class";
import { KnownFailure } from "@/server/core/paid-call";
import { LANGS, type Lang } from "@/server/core/lang";
import type { StageContext } from "@/server/core/stage-handler";
import { BlockedAddressError } from "../net/safe-fetch";
import { MODELS, type Alignment, type ElevenLabsDeps, type SafeFetch } from "./eleven-types";
import type { VoiceProvider, WordTiming } from "./index";

const HOST = "https://api.elevenlabs.io";
const MAX_BODY = 50 * 1024 * 1024;
const MAX_TAG = 80;
export const LIBRARY_VOICE = "This voice is a library voice: free accounts cannot use it via the API. Use a voice from your own account.";
const BEFORE_SEND = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** Plain text before the line: control characters removed, at most 80 code points. */
function tagPrefix(raw: string | undefined): string {
  let t = Array.from((raw ?? "").replace(/\p{Cc}/gu, "").trim()).slice(0, MAX_TAG).join("");
  if (t.lastIndexOf("[") > t.lastIndexOf("]")) t = t.slice(0, t.lastIndexOf("[")).trim(); // drop a tag cut open by the cap
  return t;
}

// v2 multilingual covers en/hi/ta; v3 covers every language we speak.
const V2_LANGS: readonly Lang[] = ["en", "hi", "ta"];
export const isMpeg = (b: Buffer) => b.subarray(0, 3).toString("latin1") === "ID3" || (b.length > 1 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0);

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

/** At most the first 2000 characters of an error body; never reads on. */
async function readHead(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder();
  let out = "";
  try {
    while (out.length < 2000) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
  } catch { /* unreadable: treated as empty */ } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.slice(0, 2000);
}

export async function readCapped(res: Response, who = "ElevenLabs"): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_BODY) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`${who} response is over the 50 MB limit.`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`${who} sent no body.`);
  for (;;) {
    const { done, value } = await reader.read(); // a reset or truncated body throws here: outcome unknown
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${who} response is over the 50 MB limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * One JSON POST to a typed provider host. 4xx (not 408) = rejected before work (429 retried by the classifier, the rest permanent);
 * 5xx, 408 and socket loss after send = unknown. `billedRefusal` lets an adapter treat a 4xx body it knows may still be billed as unknown.
 */
export async function postJson(
  who: string, fetch: SafeFetch, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal,
  billedRefusal?: (status: number, text: string) => boolean,
): Promise<Response> {
  let res: Response;
  try {
    // maxRedirects 0: a redirect would re-POST (a second paid request); it surfaces as an error after send = unknown.
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal }, { timeoutMs: 120_000, maxRedirects: 0 });
  } catch (err) {
    if (signal.aborted) throw signal.reason; // cancel/timeout after send: unknown
    if (err instanceof BlockedAddressError) throw new NotProcessedError(`${who} address was blocked.`);
    const code = (err as { cause?: { code?: unknown } })?.cause?.code;
    if (typeof code === "string" && BEFORE_SEND.has(code)) throw new NotProcessedError(`${who} could not be reached.`, { code });
    throw new Error(`${who} request failed after it was sent.`); // fixed text: no cause, no URL, no key
  }
  if (res.ok) return res;
  const text = res.status >= 400 && res.status <= 499 ? await readHead(res) : (await res.body?.cancel().catch(() => undefined), "");
  if (res.status >= 400 && res.status <= 499 && res.status !== 408 && !billedRefusal?.(res.status, text)) {
    const code = /"code"\s*:\s*"([a-z_]{1,40})"/.exec(text)?.[1]; // the provider's short error word only; the body is never kept or shown
    throw new NotProcessedError(`${who} refused the request (${res.status}).`, { status: res.status, ...(code ? { code } : {}) });
  }
  throw new Error(`${who} answered ${res.status}; the outcome is unknown.`);
}

export const elevenPost = (fetch: SafeFetch, key: string, signal: AbortSignal, pathQuery: string, body: unknown, accept: string) =>
  postJson("ElevenLabs", fetch, `${HOST}${pathQuery}`, { "xi-api-key": key, accept }, body, signal);

export function createElevenLabsVoice(deps: ElevenLabsDeps): VoiceProvider {
  const prefix = tagPrefix(deps.tags?.prefix);
  // Emotion tags are a v3 feature: other models would speak "[excited]" aloud.
  const sent = (text: string, model: string) => (prefix && model === "eleven_v3" ? `${prefix} ${text}` : text);

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
    const { price, model } = check(a);
    return priceQuote(price, Array.from(sent(a.text, model)).length);
  };

  return {
    capability: { id: "elevenlabs", wordTimings: "native", local: false, languages: deps.model === "eleven_v3" ? [...LANGS] : [...V2_LANGS], maxChars: 3500, formats: ["mp3"] },
    quote,
    async synthesise(ctx: StageContext, a) {
      const { model, voice } = check(a);
      const reserve = quote(a);
      const text = sent(a.text, model);
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
          res = await elevenPost(deps.fetch, key, signal, `/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, { text, model_id: model }, "application/json");
        } catch (err) {
          // Live free-tier answer (2026-10-30): 402 paid_plan_required = a library voice, refused before any work.
          if (err instanceof NotProcessedError && err.status === 402 && err.code === "paid_plan_required") throw new NotProcessedError(LIBRARY_VOICE, { status: 402, code: err.code });
          throw err;
        }
        const body = await readCapped(res);
        const json = JSON.parse(body.toString("utf8")) as { audio_base64?: unknown; alignment?: unknown };
        if (typeof json.audio_base64 !== "string" || json.audio_base64 === "") throw new Error("ElevenLabs returned no audio.");
        const audio = Buffer.from(json.audio_base64, "base64");
        if (!isMpeg(audio)) throw new Error("ElevenLabs returned audio that is not MP3."); // billed: unknown, parks
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
