import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProbeResult } from "../core/qa";

// SECURITY CONTROL: the only place QA touches video files. Binaries run with an args array (no shell), a
// scrubbed environment (no secrets), a hard timeout, an output cap, and only on files under the storage root.
// Task 09's shared runChild does not exist yet; this uses the same rules and can move onto it later.
export const TIMEOUT_MS = 30_000;
const OUT_CAP = 8 * 1024 * 1024;
const SAFE_ENV_KEYS = ["PATH", "LANG", "LC_ALL"] as const;

export class ProbeError extends Error {}

export interface ProbeOptions {
  storageRoot: string;
  attemptDir?: string; // when set, two review frames are written here for the human gate
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv; // test hook: where PATH comes from
  ffprobeBin?: string;
  ffmpegBin?: string;
}

export function cleanEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) { const v = src[k]; if (v !== undefined) out[k] = v; }
  return out;
}

export interface ExecOpts {
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  withStderr?: boolean;
}

export function exec(bin: string, args: string[], o: ExecOpts): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    execFile(
      bin,
      args,
      { env: o.env as NodeJS.ProcessEnv, timeout: o.timeoutMs, maxBuffer: OUT_CAP, signal: o.signal, encoding: "buffer", killSignal: "SIGKILL" },
      (err: Error | null, stdout: Buffer, stderr: Buffer) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.name === "AbortError") return reject(new ProbeError("Video check was cancelled."));
          if (e.killed) return reject(new ProbeError("Video check timed out."));
          if (e.code === "ENOENT") return reject(new ProbeError(`${path.basename(bin)} is not installed.`));
          return reject(new ProbeError(`${path.basename(bin)} could not read this video: ${stderr.toString("utf8").trim().slice(-300) || e.message}`));
        }
        resolve(o.withStderr ? Buffer.concat([stdout, stderr]) : stdout);
      },
    );
  });
}

async function assertUnderRoot(file: string, root: string): Promise<string> {
  let real: string;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
    real = await fs.realpath(file);
  } catch {
    throw new ProbeError("Video file not found.");
  }
  if (!real.startsWith(realRoot + path.sep)) throw new ProbeError("Video file is outside the storage folder.");
  if (!(await fs.stat(real)).isFile()) throw new ProbeError("Video path is not a file.");
  return real;
}

function dbOf(text: string, label: string): number | null {
  const m = new RegExp(`${label}:\\s*(-?[\\d.]+|-inf) dB`).exec(text);
  if (!m) return null;
  return m[1] === "-inf" ? -91 : Number(m[1]);
}

export async function probeVideo(file: string, signal: AbortSignal, opts: ProbeOptions): Promise<ProbeResult> {
  const real = await assertUnderRoot(file, opts.storageRoot);
  const base = { env: cleanEnv(opts.env ?? process.env), timeoutMs: opts.timeoutMs ?? TIMEOUT_MS, signal };
  const ffprobe = opts.ffprobeBin ?? "ffprobe";
  const ffmpeg = opts.ffmpegBin ?? "ffmpeg";

  let info: { streams?: Array<{ codec_type?: string; width?: number; height?: number }>; format?: { duration?: string } };
  try {
    const out = await exec(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-i", real], base);
    info = JSON.parse(out.toString("utf8"));
  } catch (err) {
    if (err instanceof ProbeError && !/could not read/.test(err.message)) throw err;
    throw new ProbeError("This file is not a readable video.");
  }
  const v = info.streams?.find((s) => s.codec_type === "video");
  const durationS = Number(info.format?.duration);
  if (!v?.width || !v.height || !Number.isFinite(durationS)) throw new ProbeError("This file is not a readable video.");
  const hasAudio = !!info.streams?.some((s) => s.codec_type === "audio");

  let meanDb: number | null = null;
  let peakDb: number | null = null;
  if (hasAudio) {
    const text = (await exec(ffmpeg, ["-hide_banner", "-nostats", "-i", real, "-vn", "-af", "volumedetect", "-f", "null", "-"], { ...base, withStderr: true })).toString("utf8");
    meanDb = dbOf(text, "mean_volume");
    peakDb = dbOf(text, "max_volume");
  }

  // Loop seam: first and last frame as 32x32 gray, mean absolute difference (0..255).
  const small = ["-frames:v", "1", "-vf", "scale=32:32,format=gray", "-f", "rawvideo", "-"];
  const first = await exec(ffmpeg, ["-v", "error", "-i", real, ...small], base);
  const last = await exec(ffmpeg, ["-v", "error", "-sseof", "-0.2", "-i", real, "-update", "1", ...small], base);
  let loopDiff: number | null = null;
  if (first.length === 1024 && last.length === 1024) {
    let sum = 0;
    for (let i = 0; i < 1024; i++) sum += Math.abs((first[i] ?? 0) - (last[i] ?? 0));
    loopDiff = sum / 1024;
  }

  if (opts.attemptDir) {
    await fs.mkdir(opts.attemptDir, { recursive: true });
    await exec(ffmpeg, ["-v", "error", "-y", "-i", real, "-frames:v", "1", path.join(opts.attemptDir, "review-first.png")], base);
    await exec(ffmpeg, ["-v", "error", "-y", "-sseof", "-0.2", "-i", real, "-update", "1", "-frames:v", "1", path.join(opts.attemptDir, "review-last.png")], base);
  }

  return { width: v.width, height: v.height, durationS, hasAudio, meanDb, peakDb, loopDiff };
}
