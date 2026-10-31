// Pure QA findings over parsed ffprobe/ffmpeg output. No I/O. The adapter (render/qa-scan.ts) measures; this file parses and judges.
export type Severity = "info" | "warn" | "block";
export interface Finding { id: string; severity: Severity; text: string }
export interface Run { start: number; end: number; duration: number }

export interface ProbeFacts {
  durationS: number;
  sizeBytes: number;
  video: { codec: string; width: number; height: number; fps: number } | null;
  audioCodec: string | null;
}
export interface Scan {
  facts: ProbeFacts;
  blackRuns: Run[];
  freezeRuns: Run[];
  lufs: number | null; // integrated loudness; null when unmeasurable
  truePeakDb: number | null;
  meanDb: number | null;
  narrationS: number | null;
}
export interface FindingOpts {
  minS: number; maxS: number; maxBytes: number; stillMaxS: number; width: number; height: number; fps: number;
  lufsMin: number; lufsMax: number; truePeakMax: number; audibleDb: number; narrationToleranceS: number;
}
export const FINDING_DEFAULTS: FindingOpts = {
  minS: 1, maxS: 180, maxBytes: 256 * 1024 * 1024, stillMaxS: 2, width: 1080, height: 1920, fps: 30,
  lufsMin: -20, lufsMax: -12, truePeakMax: -1, audibleDb: -50, narrationToleranceS: 1,
};

export function parseFfprobe(json: string): ProbeFacts {
  const j = JSON.parse(json) as { streams?: Array<Record<string, unknown>>; format?: { duration?: string; size?: string } };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const [n, d] = String(v?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationS: Number(j.format?.duration),
    sizeBytes: Number(j.format?.size),
    video: v ? { codec: String(v.codec_name), width: Number(v.width), height: Number(v.height), fps: d ? (n ?? 0) / d : 0 } : null,
    audioCodec: a ? String(a.codec_name) : null,
  };
}

export function parseBlackdetect(text: string): Run[] {
  const out: Run[] = [];
  for (const m of text.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) {
    out.push({ start: Number(m[1]), end: Number(m[2]), duration: Number(m[3]) });
  }
  return out;
}

/** A freeze still running when the file ends has a start and no end: it is closed at `endOfFile`. */
export function parseFreezedetect(text: string, endOfFile: number): Run[] {
  const out: Run[] = [];
  let start: number | null = null;
  for (const m of text.matchAll(/freeze_(start|end): ([\d.]+)/g)) {
    const t = Number(m[2]);
    if (m[1] === "start") start = t;
    else if (start !== null) { out.push({ start, end: t, duration: t - start }); start = null; }
  }
  if (start !== null) out.push({ start, end: endOfFile, duration: endOfFile - start });
  return out;
}

const num = (s: string | undefined) => (s === undefined ? null : s === "-inf" ? -91 : Number(s));

/** Reads the closing summary that ebur128 (peak=true) and volumedetect print. */
export function parseLoudness(text: string): { lufs: number | null; truePeakDb: number | null; meanDb: number | null } {
  const summary = text.slice(text.lastIndexOf("Summary:") >= 0 ? text.lastIndexOf("Summary:") : 0);
  return {
    lufs: num(/\bI:\s+(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1]),
    truePeakDb: num(/\bPeak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1]),
    meanDb: num(/mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(text)?.[1]),
  };
}

export function qaFindings(s: Scan, o: FindingOpts = FINDING_DEFAULTS): Finding[] {
  const out: Finding[] = [];
  const add = (id: string, severity: Severity, text: string) => out.push({ id, severity, text });
  const f = s.facts;

  if (!f.video) add("video_stream", "block", "The file has no video track.");
  else {
    if (f.video.codec !== "h264") add("video_codec", "block", `Video is ${f.video.codec}, it must be h264.`);
    if (f.video.width !== o.width || f.video.height !== o.height) add("size", "block", `Size is ${f.video.width}x${f.video.height}, it must be ${o.width}x${o.height}.`);
    if (Math.abs(f.video.fps - o.fps) > 0.5) add("fps", "warn", `Frame rate is ${f.video.fps.toFixed(1)}, expected ${o.fps}.`);
  }
  if (!f.audioCodec) add("audio_present", "block", "The video has no audio track.");
  else if (f.audioCodec !== "aac") add("audio_codec", "block", `Audio is ${f.audioCodec}, it must be aac.`);
  if (!(f.durationS >= o.minS && f.durationS <= o.maxS)) add("duration", "block", `Length is ${f.durationS.toFixed(1)}s, it must be ${o.minS}-${o.maxS}s.`);
  if (f.sizeBytes > o.maxBytes) add("file_size", "block", `File is ${(f.sizeBytes / 1048576).toFixed(0)} MB, the limit is ${(o.maxBytes / 1048576).toFixed(0)} MB.`);

  if (s.narrationS !== null && Math.abs(f.durationS - s.narrationS) > o.narrationToleranceS) {
    add("narration_length", "warn", `Video is ${f.durationS.toFixed(1)}s but the narration is ${s.narrationS.toFixed(1)}s.`);
  }

  if (s.blackRuns.some((r) => r.start <= 0.05)) add("first_frame_black", "block", "The first frame is black, so the video starts without a composed picture.");
  for (const r of s.blackRuns) if (r.start > 0.05 && r.duration > o.stillMaxS) add("black_run", "warn", `Black screen from ${r.start.toFixed(1)}s for ${r.duration.toFixed(1)}s.`);
  for (const r of s.freezeRuns) if (r.duration > o.stillMaxS) add("frozen_run", "warn", `Picture frozen from ${r.start.toFixed(1)}s for ${r.duration.toFixed(1)}s.`);

  if (f.audioCodec) {
    if (s.meanDb !== null && s.meanDb <= o.audibleDb) add("silent", "block", `Audio is silent (mean ${s.meanDb.toFixed(0)} dB).`);
    else if (s.lufs !== null && (s.lufs < o.lufsMin || s.lufs > o.lufsMax)) add("loudness", "warn", `Loudness is ${s.lufs.toFixed(1)} LUFS, aim for ${o.lufsMin} to ${o.lufsMax}.`);
    if (s.truePeakDb !== null && s.truePeakDb > o.truePeakMax) add("clipping", "warn", `Audio peaks at ${s.truePeakDb.toFixed(1)} dBTP, it may clip (limit ${o.truePeakMax}).`);
  }
  if (out.length === 0) add("all_clear", "info", "All automatic checks passed.");
  return out;
}
