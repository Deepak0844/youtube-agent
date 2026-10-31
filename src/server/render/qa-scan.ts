import { promises as fs } from "node:fs";
import path from "node:path";
import { parseBlackdetect, parseFfprobe, parseFreezedetect, parseLoudness, type Scan } from "../core/qa-findings";
import { cleanEnv, exec, ProbeError, TIMEOUT_MS, type ProbeOptions } from "./probe";

// SECURITY CONTROL: ffmpeg/ffprobe via execFile (args array, no shell), scrubbed env, timeout, output cap, killed on abort
// (all inside probe.ts exec). The file must live under the storage root. Stills go only into the attempt folder.
export interface ScanOptions extends ProbeOptions {
  attemptDir: string;
  /** Black or frozen picture only counts after this many seconds. */
  stillMinS?: number;
  /** Narration audio to compare lengths with (absolute path under the storage root), when there is one. */
  narrationFile?: string;
}
export const STILLS = ["poster-first.png", "poster-middle.png", "poster-last.png"] as const;
export type QaScanner = (file: string, signal: AbortSignal, o: ScanOptions) => Promise<Scan>;

export const scanVideo: QaScanner = async (file, signal, o) => {
  const real = await fs.realpath(file).catch(() => { throw new ProbeError("Video file not found."); });
  const root = await fs.realpath(o.storageRoot);
  if (!real.startsWith(root + path.sep)) throw new ProbeError("Video file is outside the storage folder.");
  const base = { env: cleanEnv(o.env ?? process.env), timeoutMs: o.timeoutMs ?? TIMEOUT_MS, signal };
  const ffprobe = o.ffprobeBin ?? "ffprobe";
  const ffmpeg = o.ffmpegBin ?? "ffmpeg";
  const probe = (f: string) => exec(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-i", f], base);

  const facts = parseFfprobe((await probe(real)).toString("utf8"));
  const still = o.stillMinS ?? 2;
  const vf = `blackdetect=d=0.05:pix_th=0.10,freezedetect=n=-60dB:d=${still}`;
  const text = (await exec(ffmpeg, ["-hide_banner", "-nostats", "-i", real, "-vf", vf, "-af", "ebur128=peak=true:framelog=quiet,volumedetect", "-f", "null", "-"], { ...base, withStderr: true })).toString("utf8");

  await fs.mkdir(o.attemptDir, { recursive: true });
  const at = (s: number) => ["-v", "error", "-y", "-ss", String(s), "-i", real, "-frames:v", "1"];
  await exec(ffmpeg, [...at(0), path.join(o.attemptDir, STILLS[0])], base);
  await exec(ffmpeg, [...at(Math.max(0, facts.durationS / 2)), path.join(o.attemptDir, STILLS[1])], base);
  await exec(ffmpeg, ["-v", "error", "-y", "-sseof", "-0.2", "-i", real, "-update", "1", "-frames:v", "1", path.join(o.attemptDir, STILLS[2])], base);

  let narrationS: number | null = null;
  if (o.narrationFile) {
    const nreal = await fs.realpath(o.narrationFile).catch(() => null);
    if (nreal?.startsWith(root + path.sep)) narrationS = parseFfprobe((await probe(nreal)).toString("utf8")).durationS;
  }
  return { facts, blackRuns: parseBlackdetect(text), freezeRuns: parseFreezedetect(text, facts.durationS), ...parseLoudness(text), narrationS: Number.isFinite(narrationS) ? narrationS : null };
};
