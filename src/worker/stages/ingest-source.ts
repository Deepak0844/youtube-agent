import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { audioChunkArgs, checkSourceProbe, chunkPlan, mergeChunkWords, probeSourceArgs, transcodeSourceArgs, UPLOAD_FILE, type SttWord } from "@/server/core/source-ingest";
import type { Transcriber } from "@/server/providers/stt/voicestudio-stt";
import { runMediaTool } from "@/server/render/mix";
import { promotedPath, type AttemptHandler } from "./attempt";
import { loadVideo, type StageDeps } from "./deps";

const MIN_WORDS = 20;
const TRANSCODE_TIMEOUT_MS = 25 * 60_000;

/**
 * On demand (Clip Factory, upload source). Turns an UPLOADED video into a clip source: probe it (only a plain video container passes), re-encode
 * it into a fresh mp4 (the upload itself is never cut, rendered or shown), listen to it with the owner's own VoiceStudio speech-to-text in
 * 60 s pieces, and save the words as the video's captions. Free and local: no model API, no money. The raw upload is deleted when the step
 * ends, whatever the outcome. A refusal is a plain sentence. Nothing here publishes anything.
 */
export function ingestSourceAttempt(deps: StageDeps, o: { transcriber: () => Promise<Transcriber> }): AttemptHandler {
  return async (ctx) => {
    if (!deps.mix) throw new KnownFailure("No video tool is wired, so the upload cannot be prepared.");
    const mix = deps.mix;
    const video = await loadVideo(deps.db, ctx);
    const raw = await promotedPath(deps.root, video.id, UPLOAD_FILE);
    try {
      // ffprobe exits with an error on a file that is not media at all: that is the owner's file problem, in plain words
      const lines = await runMediaTool(mix, ctx, "ffprobe", probeSourceArgs(raw), "Reading the uploaded video").catch((e) => {
        if (e instanceof KnownFailure) throw new KnownFailure("The file could not be read as a video. Use an mp4, mov, mkv or webm video.");
        throw e;
      });
      const probed = checkSourceProbe(lines.join("\n"));
      if (!probed.ok) throw new KnownFailure(probed.reason);

      const clean = path.join(ctx.attemptDir, "final.mp4");
      await runMediaTool(mix, ctx, "ffmpeg", transcodeSourceArgs(raw, clean), "Preparing the uploaded video", TRANSCODE_TIMEOUT_MS);
      const prepared = checkSourceProbe((await runMediaTool(mix, ctx, "ffprobe", probeSourceArgs(clean), "Checking the prepared video")).join("\n"));
      if (!prepared.ok) throw new KnownFailure(prepared.reason);
      const durationS = prepared.facts.durationS;

      const stt = await o.transcriber();
      const pieces: Array<{ startS: number; words: SttWord[] }> = [];
      for (const [i, c] of chunkPlan(durationS).entries()) {
        const wav = path.join(ctx.attemptDir, `chunk-${i}.wav`);
        await runMediaTool(mix, ctx, "ffmpeg", audioChunkArgs(clean, wav, c), "Cutting the audio");
        try {
          pieces.push({ startS: c.startS, words: await stt.transcribe(await readFile(wav), video.language, ctx.signal) });
        } catch (e) {
          if (e instanceof KnownFailure || ctx.signal.aborted) throw e;
          throw new KnownFailure(`Speech-to-text failed: ${(e instanceof Error ? e.message : "unknown error").slice(0, 300)}`);
        } finally {
          await rm(wav, { force: true });
        }
        ctx.log(`ingest: audio piece ${i + 1} done`);
      }
      const words = mergeChunkWords(pieces, durationS);
      if (words.length < MIN_WORDS) throw new KnownFailure(`Only ${words.length} spoken words were found, so there is nothing to cut clips by. Use a video with clear speech.`);
      const captions = { timings_kind: "aligned", words, needs_check: false, flags: [], approximate: false };
      return { files: ["final.mp4"], content: [{ kind: "captions", body: captions }], result: { durationS: Math.round(durationS * 10) / 10, words: words.length } };
    } finally {
      await rm(raw, { force: true }).catch(() => undefined); // the untrusted upload never stays on disk
    }
  };
}
