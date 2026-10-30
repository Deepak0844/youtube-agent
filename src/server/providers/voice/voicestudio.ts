import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ipaddr from "ipaddr.js";
import { FormData } from "undici"; // safeFetch sends with undici, which does not understand the global FormData
import { estimateTimings, mapToScript, type Recognised } from "@/server/core/alignment";
import { LANGS } from "@/server/core/lang";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { callServer, MAX_AUDIO_BYTES, postJson, readJson, saveCapped } from "./local-http";
import { joinWav, parseWav, wavSeconds } from "./wav";
import type { TimingsKind, VoiceProvider, WordTiming } from "./index";

export const CHUNK_CHARS = 3500; // the server limit is 4096

export class VoiceUrlError extends KnownFailure {
  constructor(message: string) {
    super(message);
    this.name = "VoiceUrlError";
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (h.toLowerCase() === "localhost") return true;
  if (!ipaddr.isValid(h)) return false;
  const a = ipaddr.parse(h);
  return a.kind() === "ipv6" && (a as ipaddr.IPv6).isIPv4MappedAddress() ? false : a.range() === "loopback";
}

/** VoiceStudio has no login of its own on loopback. Anywhere else it must be reached with a key, or it is refused. */
export function assertVoiceStudioUrl(url: string, hasKey: boolean): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new VoiceUrlError("The VoiceStudio address is not a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new VoiceUrlError("The VoiceStudio address must start with http:// or https://.");
  if (u.username !== "" || u.password !== "") throw new VoiceUrlError("The VoiceStudio address must not contain a user name or password.");
  if (hasKey && u.protocol !== "https:" && !isLoopbackHost(u.hostname)) throw new VoiceUrlError("A key must not be sent over plain http to another computer. Use an https address.");
  if (!hasKey && !isLoopbackHost(u.hostname)) {
    throw new VoiceUrlError("VoiceStudio is not on this computer, so an API key is required. Add a key, or use the address 127.0.0.1.");
  }
}

/** Sentence-aware packing into pieces of at most `max` characters; a single over-long run is cut at a word, then at a character. */
export function chunkText(text: string, max = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let cur = "";
  const push = (s: string) => {
    if (cur && (cur + s).length > max) { out.push(cur.trim()); cur = ""; }
    cur += s;
  };
  for (const sentence of text.match(/[^.!?।\n]*[.!?।]*\s*/gu) ?? []) {
    if (sentence.length <= max) { push(sentence); continue; }
    for (const word of sentence.match(/\S+\s*/gu) ?? []) {
      if (word.length <= max) push(word);
      else for (let i = 0, cps = Array.from(word); i < cps.length; i += max) push(cps.slice(i, i + max).join(""));
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface VoiceStudioCfg {
  baseUrl: string;
  localServices: readonly string[];
  getKey?: () => Promise<string | null>;
  voice: string;
  /** Speech model id. VoiceStudio wants an OpenAI TTS id (tts-1, tts-1-hd, gpt-4o-mini-tts); "default" is refused (400). */
  speechModel?: string;
  language?: string;
  speed?: number;
  seed?: number;
}

function recognisedWords(json: unknown): Recognised[] {
  const words = (json as { words?: unknown } | null)?.words;
  if (!Array.isArray(words)) throw new Error("VoiceStudio's word timing answer had no words.");
  return words.map((w: { word?: unknown; start?: unknown; end?: unknown }) => {
    if (typeof w?.word !== "string" || typeof w.start !== "number" || typeof w.end !== "number" || !Number.isFinite(w.start) || !Number.isFinite(w.end)) {
      throw new Error("VoiceStudio's word timing answer was not in the expected form.");
    }
    return { word: w.word, startS: w.start, endS: w.end, p: 1 };
  });
}

/** VoiceStudio over its OpenAI-style API: chunked speech, then word times from the same server mapped onto the script. Free. */
export function createVoiceStudioVoice(cfg: VoiceStudioCfg): VoiceProvider {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  return {
    capability: { id: "voicestudio", wordTimings: "aligned", local: true, languages: [...LANGS], maxChars: CHUNK_CHARS, formats: ["wav"] },
    quote: () => 0,
    async synthesise(ctx: StageContext, a) {
      assertVoiceStudioUrl(cfg.baseUrl, Boolean(await cfg.getKey?.()));
      const chunks = chunkText(a.text);
      const stem = path.join(ctx.attemptDir, `voice-${createHash("sha256").update(`${a.lang}\0${a.voice}\0${a.text}`).digest("hex").slice(0, 12)}`);
      const audioPath = `${stem}.wav`;
      const partPaths = chunks.map((_c, i) => `${stem}-${i}.part`);
      try {
        const timings = await ctx.paid({ reserveMicroUsd: 0, budgetScopes: [], kind: "paid" }, async (_key, signal) => {
          const parts = [];
          const words: WordTiming[] = [];
          let kind: TimingsKind = "aligned";
          let offset = 0;
          let used = 0;
          for (const [i, chunk] of chunks.entries()) {
            const speech = JSON.stringify({
              model: cfg.speechModel ?? "tts-1", input: chunk, voice: a.voice || cfg.voice, response_format: "wav", language: cfg.language ?? a.lang,
              ...(cfg.speed !== undefined && { speed: cfg.speed }), ...(cfg.seed !== undefined && { seed: cfg.seed }),
            });
            await saveCapped(await postJson(`${base}/v1/audio/speech`, speech, cfg, signal), partPaths[i]!, MAX_AUDIO_BYTES - used);
            const bytes = await readFile(partPaths[i]!);
            used += bytes.length;
            const wav = parseWav(bytes);
            const dur = wavSeconds(wav);
            const form = new FormData();
            form.set("file", new Blob([bytes], { type: "audio/wav" }), "chunk.wav");
            form.set("model", "default");
            form.set("response_format", "verbose_json");
            form.append("timestamp_granularities[]", "word");
            form.set("language", cfg.language ?? a.lang);
            const res = await callServer(`${base}/v1/audio/transcriptions`, { method: "POST", body: form as unknown as BodyInit }, cfg, signal);
            const script = chunk.split(/\s+/u).filter(Boolean);
            const { words: mapped, stats } = mapToScript(script, recognisedWords(await readJson(res)), dur);
            // Mostly unmatched is not "aligned": say estimated, and keep the per-word marks so QA can see where.
            if (mapped.length === 0 || stats.matched < 0.7 * stats.scriptWords) kind = "estimated";
            for (const w of mapped.length ? mapped : estimateTimings(script, dur)) words.push({ word: w.word, startS: w.startS + offset, endS: w.endS + offset, flags: w.flags, source: w.source });
            offset += dur;
            parts.push(wav);
          }
          await writeFile(audioPath, joinWav(parts), { mode: 0o600 });
          return { result: { words, kind }, actualMicroUsd: 0 };
        });
        return { audioPath, wordTimings: timings.words, timingsKind: timings.kind, priceMicroUsd: 0, quoted: true };
      } catch (e) {
        await rm(audioPath, { force: true });
        throw e;
      } finally {
        await Promise.all(partPaths.map((p) => rm(p, { force: true })));
      }
    },
  };
}
