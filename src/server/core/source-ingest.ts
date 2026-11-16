// Clip Factory CF5 (U1): everything about taking an UPLOADED video as a clip source that needs no IO. Pure.
// An upload is untrusted. Two defences before any clip is cut from it (see the shortcut note in core/clip-cut.ts): (1) ffprobe must report a
// plain video container (mp4/mov or matroska/webm), never a playlist or a concat or image-sequence demuxer, which could read other local files;
// (2) the file is RE-ENCODED to a fresh mp4 by ffmpeg, and only that re-encoded file is ever cut, rendered or shown. The audio is cut into
// short wav chunks for VoiceStudio's speech-to-text and the word times are put back together on the video's own timeline.

/** The name an uploaded file has next to its video row until the step that checks and re-encodes it has run (then it is deleted). */
export const UPLOAD_FILE = "upload.bin";
export const SOURCE_MIN_S = 21; // a clip is at least 15 s and at most 70% of the video (stages/clips.ts), so shorter is refused up front
export const SOURCE_MAX_S = 30 * 60;
export const SOURCE_MAX_BYTES = 1024 * 1024 * 1024;
export const SOURCE_MAX_SIDE = 8192;
export const AUDIO_CHUNK_S = 60;

/** ffprobe format_name values that are a plain video file. Anything else (hls, concat, image2, tty, lavfi, ...) is refused. */
const PLAIN_CONTAINERS: ReadonlySet<string> = new Set(["mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"]);

export interface SourceFacts {
  durationS: number;
  width: number;
  height: number;
  sizeBytes: number;
}

const num = (v: unknown): number => (typeof v === "string" || typeof v === "number" ? Number(v) : Number.NaN);

/** True when the first bytes look like an mp4/mov ("ftyp" at byte 4) or a matroska/webm (EBML magic) file. A cheap early refusal at upload time; the real check is ffprobe (checkSourceProbe). */
export function looksLikeVideo(head: Uint8Array): boolean {
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return true; // "ftyp"
  return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3; // EBML
}

/** ffprobe arguments for an upload: the file protocol only, so even probing cannot open a network address a crafted playlist names. */
export function probeSourceArgs(file: string): string[] {
  if (!file || file.startsWith("-")) throw new Error("The file name is not valid.");
  return ["-v", "error", "-protocol_whitelist", "file", "-print_format", "json", "-show_streams", "-show_format", "-i", file];
}

/** Reads `ffprobe -show_streams -show_format -print_format json` output. A plain sentence says why a file is refused. */
export function checkSourceProbe(json: string): { ok: true; facts: SourceFacts } | { ok: false; reason: string } {
  let j: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  try {
    j = JSON.parse(json);
  } catch {
    return { ok: false, reason: "The file could not be read as a video." };
  }
  const format = typeof j.format?.format_name === "string" ? j.format.format_name : "";
  if (!PLAIN_CONTAINERS.has(format)) return { ok: false, reason: "This is not a plain video file. Use an mp4, mov, mkv or webm video." };
  const v = j.streams?.find((s) => s.codec_type === "video" && s.disposition && (s.disposition as Record<string, unknown>).attached_pic !== 1) ?? j.streams?.find((s) => s.codec_type === "video");
  if (!v) return { ok: false, reason: "The file has no video picture." };
  if (!j.streams?.some((s) => s.codec_type === "audio")) return { ok: false, reason: "The file has no sound, so there is no speech to cut clips by." };
  const width = num(v.width);
  const height = num(v.height);
  const durationS = num(j.format?.duration);
  const sizeBytes = num(j.format?.size);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16 || width > SOURCE_MAX_SIDE || height > SOURCE_MAX_SIDE) return { ok: false, reason: "The video's size is not usable." };
  if (!Number.isFinite(durationS) || durationS <= 0) return { ok: false, reason: "The video's length could not be read." };
  if (durationS < SOURCE_MIN_S) return { ok: false, reason: `This video is only ${Math.round(durationS)} s long, too short to cut clips from. Use one of about ${SOURCE_MIN_S} s or more.` };
  if (durationS > SOURCE_MAX_S) return { ok: false, reason: `This video is ${Math.round(durationS / 60)} minutes long; the limit is ${SOURCE_MAX_S / 60} minutes.` };
  if (Number.isFinite(sizeBytes) && sizeBytes > SOURCE_MAX_BYTES) return { ok: false, reason: "The file is over 1 GB." };
  return { ok: true, facts: { durationS, width, height, sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0 } };
}

/** ffmpeg arguments that re-encode the upload into a clean mp4: first video and first audio stream only, at most 1920 wide, 30 fps. */
export function transcodeSourceArgs(inFile: string, outFile: string): string[] {
  if (!inFile || !outFile || inFile.startsWith("-") || outFile.startsWith("-")) throw new Error("The file names are not valid.");
  return [
    "-nostdin", "-hide_banner", "-y", "-protocol_whitelist", "file", "-i", inFile,
    "-map", "0:v:0", "-map", "0:a:0", "-sn", "-dn", "-map_metadata", "-1", "-t", String(SOURCE_MAX_S),
    "-vf", "scale='min(1920,iw)':-2,fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", outFile,
  ];
}

export interface AudioChunk {
  startS: number;
  lenS: number;
}

/** The pieces of audio sent to speech-to-text one at a time: whole chunks of AUDIO_CHUNK_S, the last one shorter. */
export function chunkPlan(durationS: number, chunkS: number = AUDIO_CHUNK_S): AudioChunk[] {
  if (!(durationS > 0) || !(chunkS > 0)) return [];
  const out: AudioChunk[] = [];
  for (let s = 0; s < durationS - 0.05; s += chunkS) out.push({ startS: s, lenS: Math.min(chunkS, durationS - s) });
  return out;
}

/** ffmpeg arguments for one chunk as 16 kHz mono wav (what the speech-to-text model reads). */
export function audioChunkArgs(inFile: string, outFile: string, c: AudioChunk): string[] {
  if (!inFile || !outFile || inFile.startsWith("-") || outFile.startsWith("-")) throw new Error("The file names are not valid.");
  return ["-nostdin", "-hide_banner", "-y", "-protocol_whitelist", "file", "-ss", c.startS.toFixed(3), "-t", c.lenS.toFixed(3), "-i", inFile, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outFile];
}

export interface SttWord {
  word: string;
  startS: number;
  endS: number;
}

/** The words of every chunk on the video's own timeline: offset by the chunk start, trimmed, in order, never ending before they start or past the video. */
export function mergeChunkWords(chunks: ReadonlyArray<{ startS: number; words: readonly SttWord[] }>, durationS: number): SttWord[] {
  const out: SttWord[] = [];
  for (const c of chunks) {
    for (const w of c.words) {
      const word = typeof w.word === "string" ? w.word.replace(/\s+/g, " ").trim() : "";
      if (!word || !Number.isFinite(w.startS) || !Number.isFinite(w.endS)) continue;
      const startS = Math.min(Math.max(0, c.startS + w.startS), durationS);
      const endS = Math.min(Math.max(startS, c.startS + w.endS), durationS);
      out.push({ word, startS: Math.round(startS * 1000) / 1000, endS: Math.round(endS * 1000) / 1000 });
    }
  }
  out.sort((a, b) => a.startS - b.startS);
  let prev = 0;
  for (const w of out) { // a word never starts before the one before it (chunk edges can overlap by a few ms)
    if (w.startS < prev) w.startS = prev;
    if (w.endS < w.startS) w.endS = w.startS;
    prev = w.startS;
  }
  return out;
}
