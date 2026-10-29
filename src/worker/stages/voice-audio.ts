import { readFile, writeFile } from "node:fs/promises";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import type { MixDeps } from "@/server/render/mix";
import { joinWav, parseWav, wavSeconds, type Wav } from "@/server/providers/voice/wav";

// Audio steps of the voice stage. ffmpeg/ffprobe run only through the child runner (deps.mix). Without it (the dry run) only
// WAV files are handled, untouched. Every processed line is mono 16-bit 24 kHz WAV, so joining them is plain byte work.

export const GAP_S = 0.12;
const FF_TIMEOUT_MS = 120_000;

async function tool(mix: MixDeps, ctx: StageContext, command: "ffmpeg" | "ffprobe", args: string[]): Promise<string[]> {
  const out: string[] = [];
  const r = await mix.runChild({
    command, args, cwd: ctx.attemptDir, cwdRoot: ctx.attemptDir, timeoutMs: FF_TIMEOUT_MS, maxOutputBytes: 1024 * 1024,
    signal: ctx.signal, onLine: (l) => out.push(l), stageRunId: ctx.claim.stageRunId,
  });
  if (r.code !== 0 || r.truncated || r.timedOut || r.aborted) throw new KnownFailure(`The voice audio could not be processed (${command} ${r.timedOut ? "timed out" : r.aborted ? "was stopped" : "returned an error"}).`);
  return out;
}

const isWav = (b: Buffer) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE";

/** Length in seconds of a provider's audio file. */
export async function audioSeconds(mix: MixDeps | undefined, ctx: StageContext, file: string): Promise<number> {
  const bytes = await readFile(file);
  if (isWav(bytes)) return wavSeconds(parseWav(bytes));
  if (!mix) throw new KnownFailure("This voice returns compressed audio and ffmpeg is not set up, so it cannot be used here.");
  const out = await tool(mix, ctx, "ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const d = Number(out[0]);
  if (!Number.isFinite(d) || d <= 0) throw new KnownFailure("Could not read the length of the voice audio.");
  return d;
}

/**
 * One line, ready to join: loudness-normalised (so providers and chunks match) and, when `tempo` > 1, sped up with atempo.
 * Without ffmpeg a WAV is used as it is and a speed-up is refused (the caller flags the line instead).
 */
export async function prepareLine(mix: MixDeps | undefined, ctx: StageContext, src: string, out: string, tempo: number): Promise<Wav> {
  if (!mix) {
    const bytes = await readFile(src);
    if (!isWav(bytes)) throw new KnownFailure("This voice returns compressed audio and ffmpeg is not set up, so it cannot be used here.");
    await writeFile(out, bytes);
    return parseWav(bytes);
  }
  const filter = [...(tempo > 1 ? [`atempo=${tempo.toFixed(4)}`] : []), "loudnorm=I=-16:TP=-1.5:LRA=11", "aresample=24000"].join(",");
  await tool(mix, ctx, "ffmpeg", ["-nostdin", "-hide_banner", "-y", "-protocol_whitelist", "file", "-i", src, "-vn", "-af", filter, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", out]);
  return parseWav(await readFile(out));
}

/** Lines joined with a fixed 120 ms of silence between them. */
export function joinWithGaps(parts: Wav[]): Buffer {
  const first = parts[0]!;
  const bits = first.fmt.readUInt16LE(14);
  const align = first.fmt.readUInt16LE(12) || 1;
  const gapBytes = Math.round(GAP_S * first.byteRate / align) * align;
  const gap: Wav = { fmt: first.fmt, byteRate: first.byteRate, data: Buffer.alloc(gapBytes, bits === 8 ? 128 : 0) };
  return joinWav(parts.flatMap((p, i) => (i === 0 ? [p] : [gap, p])));
}
