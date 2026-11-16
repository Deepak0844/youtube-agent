import { FormData } from "undici"; // safeFetch sends with undici, which does not understand the global FormData
import type { SttWord } from "@/server/core/source-ingest";
import { callServer, readJson, type Access } from "../voice/local-http";

// Speech-to-text through the owner's own VoiceStudio (free, on this Mac): one short wav chunk in, its words with times out.
// Same safe door as narration (core: loopback must be on the owner's local-service list, no redirects, capped reads). It sends audio to the
// configured server and nothing else. Requires a Whisper model installed in VoiceStudio; its refusal is passed on in plain words.
export interface Transcriber {
  /** Words of one wav chunk, times relative to the chunk. Throws an Error with a plain sentence. */
  transcribe(wav: Uint8Array, language: string, signal: AbortSignal): Promise<SttWord[]>;
}

export function createVoiceStudioStt(cfg: Access & { baseUrl: string }): Transcriber {
  return {
    async transcribe(wav, language, signal) {
      const form = new FormData();
      form.set("file", new Blob([Buffer.from(wav)], { type: "audio/wav" }), "chunk.wav");
      form.set("model", "default");
      form.set("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.set("language", language);
      let res: Response;
      try {
        res = await callServer(`${cfg.baseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`, { method: "POST", body: form as unknown as BodyInit }, cfg, signal);
      } catch (e) {
        // VoiceStudio answers 409 when no speech-to-text model is installed (the body is not read by the safe client).
        if ((e as { status?: unknown; cause?: { status?: unknown } })?.cause?.status === 409 || /answered 409/.test(String((e as Error)?.message))) throw new Error("VoiceStudio refused the request (409): it probably has no speech-to-text model installed. Install Whisper large-v3 from its model catalogue, then try again.");
        throw e;
      }
      const body = (await readJson(res)) as { words?: unknown } | null;
      if (!Array.isArray(body?.words)) throw new Error("VoiceStudio's speech-to-text answer had no words.");
      return body.words.flatMap((w: { word?: unknown; start?: unknown; end?: unknown }) =>
        typeof w?.word === "string" && typeof w.start === "number" && typeof w.end === "number" && Number.isFinite(w.start) && Number.isFinite(w.end) ? [{ word: w.word, startS: w.start, endS: w.end }] : [],
      );
    },
  };
}
