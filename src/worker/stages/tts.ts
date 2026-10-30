import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { captionsBody, estimateTimings, flagLanguage, pickTimingsKind, splitForAlignment, type AlignFlag, type CaptionWord, type TimingsKind } from "@/server/core/alignment";
import { speakingRate, wordCount, wordRange } from "@/server/core/lang";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { lineCacheKey, splitLines, tempoFitFactor } from "@/server/core/voice-lines";
import { approvedScript } from "@/server/db/stage-content";
import { dropLine, lookupLine, placeLineFile, storeLine, touchLine, type VoiceLineRow } from "@/server/db/voice-lines";
import { parseWav, wavSeconds, type Wav } from "@/server/providers/voice/wav";
import { hashStoredFile } from "@/server/storage/hash-file";
import { safeJoin } from "@/server/storage/paths";
import { sha256File, type AttemptHandler } from "./attempt";
import { loadVideo, videoMoneyScopes, type StageDeps } from "./deps";
import { audioSeconds, GAP_S, joinWithGaps, prepareLine } from "./voice-audio";

const FLAGS: readonly string[] = ["low_confidence", "too_short", "too_long", "loop", "count_mismatch", "language_unreliable", "interpolated"];
const RANK: Record<TimingsKind, number> = { native: 0, aligned: 1, estimated: 2 };
const CHUNK_S = 15;

/** The cached row for this line, or null. A row whose file is missing or changed is dropped and counts as a miss. */
async function cachedLine(deps: StageDeps, key: string): Promise<VoiceLineRow | null> {
  const row = await lookupLine(deps.db, key);
  if (!row) return null;
  const ok = await hashStoredFile(deps.root, row.filePath).then((d) => d.sha256 === row.sha256 && d.bytes === row.bytes, () => false);
  if (ok) return row;
  await dropLine(deps.db, key);
  return null;
}

/**
 * A paid call replays by (stage run, step) only. The mark records which voice route paid for this line; a retry under a different
 * route would store the old voice's audio under the new voice's cache key, so it refuses instead (the old audio stays put, never re-paid).
 */
export async function guardPaidLineVoice(pendingDir: string, lineIndex: number, key: string): Promise<void> {
  const mark = path.join(pendingDir, `line-${lineIndex}.key`);
  const prior = await readFile(mark, "utf8").catch(() => null);
  if (prior === null) return writeFile(mark, key, { mode: 0o600 });
  if (prior !== key) throw new KnownFailure("The voice changed after this line was paid for, so its saved audio belongs to the old voice. Switch the voice back, or check the provider's billing page before paying again.");
}

/**
 * TTS: narrates the APPROVED script, one cached line at a time. A line already in the cache is never paid for again; each
 * MISSING line is made by the routed adapter, which reserves and pays inside its own ctx.paid, in order, one at a time. A
 * line's row is stored as soon as its audio is on disk, so a crash after line N resumes without repaying lines 1..N.
 * Writes `narration` (one WAV) and `captions` (word times, with how they were made and what needs a human check).
 */
export function ttsAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    const approved = await approvedScript(deps.db, video.id);
    if (!approved.ok) throw new KnownFailure(approved.reason);
    const text = approved.script.narration;
    if (typeof text !== "string" || text.trim() === "") throw new KnownFailure("The script has no narration to read out.");

    // Everything that can refuse does so here, before a single line is reserved.
    const { provider, providerId, voice, model } = await deps.voiceFor({ lang: video.language, format: video.format, kind: video.kind, budgetScopes: await videoMoneyScopes(deps.db, video) });
    const cap = provider.capability;
    try {
      pickTimingsKind([cap.wordTimings]);
    } catch {
      throw new KnownFailure("This voice gives no word timings, so captions cannot be made. Pick another voice provider in Settings → Providers.");
    }
    if (!cap.languages.includes(video.language)) throw new KnownFailure("The chosen voice does not speak this video's language. Pick a voice provider in Settings → Providers.");
    // Compressed audio (mp3) needs ffprobe/ffmpeg to measure and join: refuse BEFORE paying, never after.
    if (!deps.mix && !cap.formats.includes("wav")) throw new KnownFailure("This voice returns compressed audio and ffmpeg is not set up, so it cannot be used here.");
    const lines = splitLines(text, video.language, cap.maxChars);
    if (lines.length === 0) throw new KnownFailure("The script has no narration to read out.");

    const rows: VoiceLineRow[] = [];
    let made = 0;
    for (const [lineIndex, line] of lines.entries()) {
      // The provider is part of the key, so a different provider (or a fake) can never be served this provider's line.
      const key = lineCacheKey({ text: line.text, voice, model: `${providerId}:${model ?? ""}`, lang: video.language, settings: {} });
      const hit = await cachedLine(deps, key);
      if (hit) {
        ctx.nextStep(); // keep every line on the same step number whether it was a hit or a miss, so a resumed run replays the right call
        await touchLine(deps.db, key);
        rows.push(hit);
        continue;
      }
      ctx.signal.throwIfAborted();
      // The paid audio is written to a folder that does NOT depend on the attempt's fence, so a resumed attempt (higher fence, old
      // attempt folder swept) replaying this paid step still finds the file. It is deleted only after the line's row is stored.
      const pendingDir = await safeJoin(deps.root, "voice-pending", ctx.claim.stageRunId);
      await mkdir(pendingDir, { recursive: true, mode: 0o700 });
      await guardPaidLineVoice(pendingDir, lineIndex, key);
      const r = await provider.synthesise({ ...ctx, attemptDir: pendingDir } as StageContext, { text: line.text, lang: video.language, voice, ...(model && { model }) });
      if (!(await stat(r.audioPath).then((f) => f.isFile(), () => false))) {
        throw new KnownFailure("The audio for a paid line is missing from disk. Check the provider's billing page before running this step again.");
      }
      // Into the content-addressed cache first, then measured: a measuring failure after paying leaves the audio findable on replay.
      const rel = await placeLineFile(deps.root, key, path.extname(r.audioPath).slice(1).toLowerCase(), r.audioPath);
      const durationS = await audioSeconds(deps.mix, ctx, await safeJoin(deps.root, ...rel.split("/")));
      const d = await hashStoredFile(deps.root, rel);
      const stored = await storeLine(deps.db, deps.root, { cacheKey: key, provider: providerId, bytes: d.bytes, sha256: d.sha256, durationS, wordTimings: r.wordTimings, timingsKind: r.timingsKind, filePath: rel, priceMicroUsd: r.priceMicroUsd });
      await rm(path.join(pendingDir, `line-${lineIndex}.key`), { force: true });
      await rm(r.audioPath, { force: true }); // the cache holds the copy and the row exists: a replay no longer needs the pending file
      rows.push(stored.row);
      made++;
    }

    // Tempo fit: only when the whole audio is longer than the video's window (script words at the language's pace).
    const lineWords = lines.map((l) => wordCount(l.text));
    const allWords = lineWords.reduce((a, b) => a + b, 0);
    const budgetWords = video.format === "short" ? Math.min(allWords, wordRange(video.language).max) : allWords;
    const windowS = budgetWords / speakingRate(video.language);
    const over = rows.reduce((a, r) => a + r.durationS, 0) > windowS;
    const tempo: number[] = [];
    const rewrite: number[] = [];
    rows.forEach((r, i) => {
      const lineWindow = (windowS * lineWords[i]!) / allWords;
      if (!over || !(lineWindow > 0) || r.durationS <= lineWindow) return void tempo.push(1);
      const fit = tempoFitFactor(r.durationS, lineWindow);
      // Over the cap, or no ffmpeg to speed it up: flagged for a rewrite, never chopped.
      if (!fit.fits || !deps.mix) rewrite.push(i);
      tempo.push(fit.fits && deps.mix ? fit.factor : 1);
    });

    const wavs: Wav[] = [];
    const files: string[] = [];
    try {
      for (const [i, r] of rows.entries()) {
        const out = path.join(ctx.attemptDir, `line-${i}.wav`);
        files.push(out);
        wavs.push(await prepareLine(deps.mix, ctx, await safeJoin(deps.root, ...r.filePath.split("/")), out, tempo[i]!));
      }
      const starts = wavs.map((_, i) => wavs.slice(0, i).reduce((a, w) => a + wavSeconds(w) + GAP_S, 0));

      // Word times, in order: what the provider gave (scaled by any speed-up), else whisper per chunk of at most 15 s, else even spread.
      const words: CaptionWord[] = [];
      let kind: TimingsKind = "native";
      const note = (k: TimingsKind) => void (RANK[k] > RANK[kind] && (kind = k));
      let pending: number[] = [];
      const flush = async () => {
        const idx = pending;
        pending = [];
        if (idx.length === 0) return;
        const chunks = splitForAlignment(idx.map((i) => lines[i]!.text), idx.map((i) => wavSeconds(wavs[i]!)), CHUNK_S);
        for (const [c, group] of chunks.entries()) {
          const ids = group.map((g) => idx[g]!);
          const chunkFile = path.join(ctx.attemptDir, `chunk-${ids[0]}-${c}.wav`);
          files.push(chunkFile);
          const buf = joinWithGaps(ids.map((i) => wavs[i]!));
          await writeFile(chunkFile, buf);
          const durationS = wavSeconds(parseWav(buf));
          const script = ids.flatMap((i) => lines[i]!.text.split(/\s+/u).filter(Boolean));
          let body = deps.align ? await deps.align({ audioPath: chunkFile, durationS, lang: video.language, script, stageRunId: ctx.claim.stageRunId, signal: ctx.signal }).catch((e: unknown) => { if (ctx.signal.aborted) throw e; return null; }) : null; // a cancel is never swallowed
          if (!body || body.words.length === 0) body = captionsBody("estimated", estimateTimings(script, durationS));
          if (body.timings_kind === "aligned") flagLanguage(video.language, body.words);
          note(body.timings_kind);
          for (const w of body.words) words.push({ ...w, startS: w.startS + starts[ids[0]!]!, endS: w.endS + starts[ids[0]!]! });
        }
      };
      for (const [i, r] of rows.entries()) {
        if (!r.wordTimings || r.wordTimings.length === 0) {
          pending.push(i);
          continue;
        }
        await flush();
        const k: TimingsKind = r.timingsKind === "native" || r.timingsKind === "aligned" ? r.timingsKind : "estimated";
        note(k);
        const lineWordsOut: CaptionWord[] = r.wordTimings.map((w) => ({
          word: w.word, startS: w.startS / tempo[i]! + starts[i]!, endS: w.endS / tempo[i]! + starts[i]!,
          source: w.source === "interpolated" || w.source === "estimated" ? w.source : k === "estimated" ? "estimated" : "recognised",
          flags: (w.flags ?? []).filter((f): f is AlignFlag => FLAGS.includes(f)),
        }));
        if (k === "aligned") flagLanguage(video.language, lineWordsOut);
        words.push(...lineWordsOut);
      }
      await flush();

      const caps = captionsBody(kind, words);
      const captions = rewrite.length > 0 ? { ...caps, flags: [...caps.flags, "needs_rewrite"], needs_check: true, rewrite_lines: rewrite } : caps;

      const name = "narration.wav";
      await writeFile(path.join(ctx.attemptDir, name), joinWithGaps(wavs));
      return {
        files: [name],
        content: [
          { kind: "narration", body: { file: name, audio_sha256: await sha256File(path.join(ctx.attemptDir, name)), word_timings: kind, lang: video.language, provider: providerId } },
          { kind: "captions", body: captions },
        ],
        result: { audio: name, wordTimings: kind, lines: lines.length, paidLines: made, needs_check: captions.needs_check, approximate: captions.approximate },
      };
    } finally {
      await Promise.all(files.map((f) => rm(f, { force: true })));
    }
  };
}
