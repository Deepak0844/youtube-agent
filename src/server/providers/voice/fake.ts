import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { LANGS, wordCount, type Lang } from "@/server/core/lang";
import type { StageContext } from "@/server/core/stage-handler";
import { createScript, type FakeCounters, type FakeOptions } from "../fake-base";
import type { TimingsKind, VoiceProvider } from "./index";

const RATE = 1000; // Hz: tiny on purpose, the fake only needs a valid, deterministic audio file

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

export type FakeVoiceOptions = FakeOptions & {
  priceMicroUsd?: number;
  /** Speaking pace of the audio it makes (default 3 words a second: fast enough to fit every language's window). */
  wps?: number;
  /** What it reports: `native` word times, `estimated` ones (default), or `aligned` with none returned (the stage must align). */
  timings?: "native" | "estimated" | "aligned";
  /** Languages it claims to speak (default all). */
  languages?: Lang[];
  /** File formats it claims to make (default wav). */
  formats?: string[];
  /** Runs inside the paid call, after the reserve and before the audio is made (chaos harness hook). */
  beforeCall?: (ctx: StageContext) => Promise<void>;
};

/** Pays through ctx.paid exactly as the real adapters do: one reserve per call, against the scopes it was built for. */
export function createFakeVoice(opts: FakeVoiceOptions = {}): VoiceProvider & FakeCounters & { forScopes(scopes: string[]): VoiceProvider } {
  const s = createScript(opts);
  const price = opts.priceMicroUsd ?? 1000;
  const wps = opts.wps ?? 3;
  const timings = opts.timings ?? "estimated";
  const make = (budgetScopes: string[]): VoiceProvider => ({
    capability: { id: "fake", wordTimings: timings, local: true, languages: opts.languages ?? [...LANGS], maxChars: 3500, formats: opts.formats ?? ["wav"] },
    quote: () => price,
    async synthesise(ctx: StageContext, a) {
      return ctx.paid({ reserveMicroUsd: price, budgetScopes, kind: "paid" }, async (_callKey, signal) => {
        await opts.beforeCall?.(ctx);
        const played = await s.play(`fake:voice:${ctx.claim.stageRunId}`, signal, { actualMicroUsd: price });
        const name = `voice-${createHash("sha256").update(`${a.lang}\0${a.voice}\0${a.text}`).digest("hex").slice(0, 12)}.wav`;
        const audioPath = path.join(ctx.attemptDir, name);
        const words = a.text.split(/\s+/u).filter(Boolean);
        await writeFile(audioPath, silentWav(wordCount(a.text) / wps));
        const wordTimings = timings === "aligned" ? null : words.map((word, i) => ({ word, startS: i / wps, endS: (i + 1) / wps }));
        const kind: TimingsKind = timings;
        return { result: { audioPath, wordTimings, timingsKind: kind, priceMicroUsd: played.actualMicroUsd, quoted: false }, actualMicroUsd: played.actualMicroUsd };
      });
    },
  });
  return { ...make([]), forScopes: make, calls: s.calls, totalCalls: s.totalCalls, dbCalls: s.dbCalls };
}
