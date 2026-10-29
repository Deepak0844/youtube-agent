import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSET_LIMIT_DEFAULTS } from "@/server/core/asset-rules";
import { rejectionMessage, sniff, SNIFF_HEAD_BYTES, type SniffRejection } from "@/server/core/sniff";
import type { ChildResult, ChildSpec } from "./child";

// SECURITY CONTROL: the worker-side door for untrusted uploads (Doc 13 5). Order, always:
//   size -> sniff magic bytes (name and declared type are never read) -> hash the ORIGINAL bytes -> decode/probe in a
//   child process (runChild: no shell, scrubbed env, timeout, output cap, own process group) -> write normalised files.
// The upload is deleted whatever happens (rejected, failed or accepted): the originals are not kept, only metadata-free
// derived files, so EXIF/GPS never survives. Every file written has a fixed name inside destDir; no input text becomes a path.

export type IngestRejection = SniffRejection | "empty" | "too_big" | "too_many_pixels" | "decode_failed" | "no_audio" | "too_long" | "probe_failed" | "failed";
export type IngestResult =
  | {
      ok: true;
      kind: "image" | "audio";
      mime: string; // of the stored main file
      width: number | null;
      height: number | null;
      durationS: number | null;
      bytes: number; // of the stored main file
      originalBytes: number;
      sha256: string; // of the ORIGINAL bytes (dedupe key)
      files: Record<string, string>; // role -> absolute path: main, preview, thumb, crop_916, crop_169 (image) | main, preview (audio)
    }
  | { ok: false; reason: IngestRejection; message: string };

export interface IngestDeps {
  runChild(spec: ChildSpec): Promise<ChildResult>;
}
export interface IngestArgs {
  srcPath: string;
  destDir: string;
  maxBytes?: number;
  maxPixels?: number; // image
  maxSeconds?: number; // audio
  signal?: AbortSignal;
  stageRunId?: string;
}

const IMAGE_CHILD = fileURLToPath(new URL("./image-child.mjs", import.meta.url));
const MESSAGES: Record<string, string> = {
  empty: "The file is empty.",
  too_big: "The file is too large.",
  too_many_pixels: "The image has too many pixels (limit 50 megapixels). Resize it and upload again.",
  decode_failed: "The image could not be read; it may be damaged or cut short.",
  no_audio: "This file has no audio in it.",
  too_long: "The recording is longer than the allowed length.",
  probe_failed: "The audio could not be read; it may be damaged.",
  failed: "The file could not be processed. Upload it again.",
};
const reject = (reason: IngestRejection, message?: string): IngestResult => ({
  ok: false,
  reason,
  message: message ?? (reason in MESSAGES ? MESSAGES[reason]! : rejectionMessage(reason as SniffRejection)),
});

async function sha256Of(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function readHead(file: string): Promise<Uint8Array> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(SNIFF_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

interface Gate {
  size: number;
  sha256: string;
  mime: string;
}

/** Common first steps: size, then magic bytes for the expected kind. Returns a rejection or the facts about the file. */
async function gate(a: IngestArgs, want: "image" | "audio", maxBytes: number): Promise<IngestResult | Gate> {
  let size: number;
  try {
    const st = await lstat(a.srcPath); // lstat: a symlink is not a regular file, so it is refused rather than followed
    if (!st.isFile()) return reject("failed");
    size = st.size;
  } catch {
    return reject("failed");
  }
  if (size === 0) return reject("empty");
  if (size > maxBytes) return reject("too_big");
  const s = sniff(await readHead(a.srcPath));
  if ("rejected" in s) return reject(s.rejected);
  if (s.kind !== want) return reject("unknown");
  return { size, sha256: await sha256Of(a.srcPath), mime: s.mime };
}

async function runCollect(deps: IngestDeps, a: IngestArgs, command: string, args: string[], cwd: string, timeoutMs: number, maxOutputBytes = 256 * 1024): Promise<{ r: ChildResult; lines: string[] }> {
  const lines: string[] = [];
  const r = await deps.runChild({
    command,
    args,
    cwd,
    cwdRoot: cwd,
    timeoutMs,
    maxOutputBytes,
    signal: a.signal ?? new AbortController().signal,
    onLine: (l) => lines.push(l),
    stageRunId: a.stageRunId ?? "asset-ingest",
  });
  return { r, lines };
}

// Every file name ingest can create; on any failure all of them are removed (the caller should also delete destDir).
const OUTPUT_NAMES = ["main.jpg", "main.png", "preview.webp", "thumb.webp", "crop_916.webp", "crop_169.webp", "main.flac", "preview.mp3"];
const cleanOutputs = (dir: string): Promise<unknown> => Promise.all(OUTPUT_NAMES.map((n) => rm(path.join(dir, n), { force: true })));
// ffmpeg/ffprobe otherwise guess the format from content and could pick another demuxer (HLS, concat) for a file that only starts like audio.
const DEMUXER: Record<string, string> = { "audio/wav": "wav", "audio/flac": "flac", "audio/mpeg": "mp3", "audio/mp4": "mov" };

const childOk = (r: ChildResult): boolean => r.code === 0 && !r.timedOut && !r.aborted && !r.truncated;

export async function ingestImage(deps: IngestDeps, a: IngestArgs): Promise<IngestResult> {
  let done = false;
  try {
    const g = await gate(a, "image", a.maxBytes ?? ASSET_LIMIT_DEFAULTS.maxImageBytes);
    if ("ok" in g) return g;
    const maxPixels = a.maxPixels ?? ASSET_LIMIT_DEFAULTS.maxPixels;
    const { r, lines } = await runCollect(deps, a, process.execPath, [IMAGE_CHILD, a.srcPath, a.destDir, String(maxPixels)], a.destDir, 60_000, 64 * 1024);
    let parsed: { ok: boolean; reason?: string; message?: string; mime?: string; width?: number; height?: number; bytes?: number; files?: Record<string, string> } | undefined;
    try {
      parsed = JSON.parse(lines[lines.length - 1] ?? "");
    } catch {
      parsed = undefined;
    }
    if (!childOk(r) || !parsed?.ok || !parsed.files || !parsed.mime) {
      const reason = parsed?.reason === "too_many_pixels" ? "too_many_pixels" : "decode_failed";
      return reject(reason);
    }
    const files = Object.fromEntries(Object.entries(parsed.files).map(([k, f]) => [k, path.join(a.destDir, path.basename(f))]));
    done = true;
    return { ok: true, kind: "image", mime: parsed.mime, width: parsed.width ?? null, height: parsed.height ?? null, durationS: null, bytes: parsed.bytes ?? 0, originalBytes: g.size, sha256: g.sha256, files };
  } finally {
    if (!done) await cleanOutputs(a.destDir);
    await rm(a.srcPath, { force: true });
  }
}

interface ProbeJson {
  streams?: Array<{ codec_type?: string; disposition?: { attached_pic?: number } }>;
  format?: { duration?: string };
}

export async function ingestAudio(deps: IngestDeps, a: IngestArgs): Promise<IngestResult> {
  let done = false;
  try {
    const g = await gate(a, "audio", a.maxBytes ?? ASSET_LIMIT_DEFAULTS.maxAudioBytes);
    if ("ok" in g) return g;
    const fmt = DEMUXER[g.mime];
    if (!fmt) return reject("unknown");
    // ffprobe first, in the sandbox runner. Only the plain `file` protocol is allowed, so a crafted file cannot make ffmpeg open another URL or file.
    const probeArgs = ["-v", "error", "-protocol_whitelist", "file", "-f", fmt, "-print_format", "json", "-show_streams", "-show_format", "-i", a.srcPath];
    const p = await runCollect(deps, a, "ffprobe", probeArgs, a.destDir, 30_000);
    let info: ProbeJson;
    try {
      info = JSON.parse(p.lines.join("\n"));
    } catch {
      return reject("probe_failed");
    }
    if (!childOk(p.r)) return reject("probe_failed");
    const streams = info.streams ?? [];
    if (!streams.some((s) => s.codec_type === "audio")) return reject("no_audio");
    if (streams.some((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1)) return reject("video");
    const durationS = Number(info.format?.duration);
    if (!Number.isFinite(durationS) || durationS <= 0) return reject("probe_failed");
    if (durationS > (a.maxSeconds ?? ASSET_LIMIT_DEFAULTS.maxAudioSeconds)) return reject("too_long");

    const main = path.join(a.destDir, "main.flac");
    const preview = path.join(a.destDir, "preview.mp3");
    // -vn/-map 0:a:0: first audio stream only (cover art dropped); -map_metadata -1 and bitexact: no tags written; no -ar: sample rate preserved.
    const common = ["-v", "error", "-nostdin", "-y", "-protocol_whitelist", "file", "-f", fmt, "-i", a.srcPath, "-vn", "-sn", "-dn", "-map", "0:a:0", "-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"];
    const e1 = await runCollect(deps, a, "ffmpeg", [...common, "-c:a", "flac", main], a.destDir, 300_000);
    if (!childOk(e1.r)) return reject("probe_failed");
    const e2 = await runCollect(deps, a, "ffmpeg", [...common, "-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "0", "-write_xing", "0", preview], a.destDir, 300_000);
    if (!childOk(e2.r)) return reject("probe_failed");
    const st = await stat(main);
    done = true;
    return { ok: true, kind: "audio", mime: "audio/flac", width: null, height: null, durationS, bytes: st.size, originalBytes: g.size, sha256: g.sha256, files: { main, preview } };
  } finally {
    if (!done) await cleanOutputs(a.destDir);
    await rm(a.srcPath, { force: true });
  }
}
