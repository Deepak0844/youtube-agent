import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { LANGS, wordCount } from "@/server/core/lang";
import type { StageContext } from "@/server/core/stage-handler";
import { createScript, type FakeCounters, type FakeOptions } from "../fake-base";
import type { VoiceProvider } from "./index";

const RATE = 1000; // Hz: tiny on purpose, the fake only needs a valid, deterministic audio file
const WPS = 2.5;

/** Silent mono 8-bit WAV, length from the word count. Byte-identical for the same input. */
export function silentWav(seconds: number): Buffer {
  const n = Math.max(1, Math.round(seconds * RATE));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + n, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.write("data", 36);
  h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.alloc(n, 128)]);
}

export function createFakeVoice(opts: FakeOptions & { priceMicroUsd?: number } = {}): VoiceProvider & FakeCounters {
  const s = createScript(opts);
  return {
    capability: { id: "fake", wordTimings: "estimated", local: true, languages: [...LANGS], maxChars: 3500, formats: ["wav"] },
    quote: () => opts.priceMicroUsd ?? 1000,
    calls: s.calls,
    totalCalls: s.totalCalls,
    dbCalls: s.dbCalls,
    async synthesise(ctx: StageContext, a) {
      const played = await s.play(`fake:voice:${ctx.claim.stageRunId}`, ctx.signal, { actualMicroUsd: opts.priceMicroUsd ?? 1000 });
      const name = `voice-${createHash("sha256").update(`${a.lang}\0${a.voice}\0${a.text}`).digest("hex").slice(0, 12)}.wav`;
      const audioPath = path.join(ctx.attemptDir, name);
      const words = a.text.split(/\s+/u).filter(Boolean);
      await writeFile(audioPath, silentWav(wordCount(a.text) / WPS));
      const wordTimings = words.map((word, i) => ({ word, startS: i / WPS, endS: (i + 1) / WPS }));
      return { audioPath, wordTimings, timingsKind: "estimated", priceMicroUsd: played.actualMicroUsd, quoted: false };
    },
  };
}
