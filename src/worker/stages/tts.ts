import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import type { AttemptHandler } from "./attempt";
import { sha256File } from "./attempt";
import { contentBody, DEFAULTS, loadVideo, videoMoneyScopes, type StageDeps } from "./deps";

/**
 * TTS: narrates the script. One paid call (reserved against this video, today and this month), then a `narration` content
 * version naming the audio file, its hash and how the word timings were made. The provider result carries the audio bytes
 * (fake provider only) so a resumed run can rebuild the file in its new attempt folder without paying again.
 */
export function ttsAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    const script = await contentBody<{ narration?: unknown }>(deps.db, video.id, "script");
    if (typeof script.narration !== "string" || script.narration.trim() === "") throw new KnownFailure("The script has no narration to read out.");
    const text = script.narration;

    const made = await ctx.paid<{ name: string; b64: string; wordTimings: string }>(
      { reserveMicroUsd: deps.ttsReserveMicroUsd ?? DEFAULTS.ttsReserveMicroUsd, budgetScopes: await videoMoneyScopes(deps.db, video), kind: "paid" },
      async () => {
        const r = await deps.voice.synthesise(ctx, { text, lang: video.language, voice: deps.voiceName ?? DEFAULTS.voiceName });
        return { result: { name: path.basename(r.audioPath), b64: (await readFile(r.audioPath)).toString("base64"), wordTimings: r.wordTimings }, actualMicroUsd: r.priceMicroUsd };
      },
    );
    if (made.name !== path.basename(made.name) || made.name === "" || made.name.startsWith(".")) throw new KnownFailure("The voice provider returned an unusable file name.");
    const file = path.join(ctx.attemptDir, made.name);
    await writeFile(file, Buffer.from(made.b64, "base64"));
    return {
      files: [made.name],
      content: [{ kind: "narration", body: { file: made.name, audio_sha256: await sha256File(file), word_timings: made.wordTimings, lang: video.language } }],
      result: { audio: made.name, wordTimings: made.wordTimings },
    };
  };
}
