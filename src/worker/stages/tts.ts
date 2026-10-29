import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import type { AttemptHandler } from "./attempt";
import { assertProviderName, sha256File } from "./attempt";
import { approvedScript } from "@/server/db/stage-content";
import { DEFAULTS, loadVideo, videoMoneyScopes, type StageDeps } from "./deps";

/**
 * TTS: narrates the APPROVED script (never a newer unapproved one). Narration is deliberately OUTSIDE the cost-plan quote: the
 * cost plan lists only generated media. It has its own, smaller bound: each call reserves ttsReserveMicroUsd against this
 * video's cap and today's and this month's caps, so those caps still stop it. Tested in stages-dry-run.test.ts.
 *
 * Original notes: narrates the script. One paid call (reserved against this video, today and this month), then a `narration` content
 * version naming the audio file, its hash and how the word timings were made. The provider result carries the audio bytes
 * (fake provider only) so a resumed run can rebuild the file in its new attempt folder without paying again.
 */
export function ttsAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    const approved = await approvedScript(deps.db, video.id);
    if (!approved.ok) throw new KnownFailure(approved.reason);
    const text = approved.script.narration;
    if (typeof text !== "string" || text.trim() === "") throw new KnownFailure("The script has no narration to read out.");

    const made = await ctx.paid<{ name: string; b64: string; wordTimings: string }>(
      { reserveMicroUsd: deps.ttsReserveMicroUsd ?? DEFAULTS.ttsReserveMicroUsd, budgetScopes: await videoMoneyScopes(deps.db, video), kind: "paid" },
      async () => {
        const r = await deps.voice.synthesise(ctx, { text, lang: video.language, voice: deps.voiceName ?? DEFAULTS.voiceName });
        return { result: { name: path.basename(r.audioPath), b64: (await readFile(r.audioPath)).toString("base64"), wordTimings: r.timingsKind }, actualMicroUsd: r.priceMicroUsd };
      },
    );
    assertProviderName(made.name, "voice");
    const file = path.join(ctx.attemptDir, made.name);
    await writeFile(file, Buffer.from(made.b64, "base64"));
    return {
      files: [made.name],
      content: [{ kind: "narration", body: { file: made.name, audio_sha256: await sha256File(file), word_timings: made.wordTimings, lang: video.language } }],
      result: { audio: made.name, wordTimings: made.wordTimings },
    };
  };
}
