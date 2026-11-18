// Clip Factory CF2a: ffmpeg arguments that cut one clip out of a source video and make it a 1080x1920 portrait video.
// The sharp picture is fitted inside the frame (never cropped, never stretched) over a blurred, dimmed copy of itself that
// fills the frame, so a landscape source is not blindly centre-cropped. Pure: builds arguments only; the caller runs ffmpeg
// through the child runner. Captions are not drawn here (CF2b).
// shortcut: the source must be an app-made file, or an upload probed as a real container (mp4, mov, mkv, webm) first: the file-only
// protocol list blocks the network but a crafted playlist file could still read other local files. The caller also clamps endS to the source length.

export const CLIP_W = 1080;
export const CLIP_H = 1920;
export const CLIP_FPS = 30;
const MAX_CLIP_S = 180; // the longest a short may be

export interface ClipCut {
  inFile: string;
  outFile: string;
  startS: number;
  endS: number;
  /** Share of the picture's height cut off its bottom before it is fitted (0 to 0.25). An app-made video has its own captions burned in there; the clip draws new ones. */
  cropBottom?: number;
}

/** A plain sentence saying what is wrong with the cut, or null when it is fine. */
export function clipCutProblem(c: ClipCut): string | null {
  if (!Number.isFinite(c.startS) || !Number.isFinite(c.endS) || c.startS < 0) return "The clip times are not valid.";
  if (!(c.endS > c.startS)) return "The clip must end after it starts.";
  if (c.endS - c.startS > MAX_CLIP_S) return `A clip can be at most ${MAX_CLIP_S} seconds.`;
  if (c.cropBottom !== undefined && !(c.cropBottom >= 0 && c.cropBottom <= 0.25)) return "The bottom crop must be between 0 and 0.25.";
  if (!c.inFile || !c.outFile || c.inFile.startsWith("-") || c.outFile.startsWith("-")) return "The file names are not valid."; // never read as an option
  return null;
}

/** The ffmpeg arguments, or throws with the plain sentence from clipCutProblem. */
export function cutClipArgs(c: ClipCut): string[] {
  const bad = clipCutProblem(c);
  if (bad) throw new Error(bad);
  const size = `${CLIP_W}:${CLIP_H}`;
  const graph =
    `[0:v]${c.cropBottom ? `crop=iw:trunc(ih*${(1 - c.cropBottom).toFixed(3)}/2)*2:0:0,` : ""}split=2[a][b];` +
    `[a]scale=${size}:force_original_aspect_ratio=increase,crop=${size},boxblur=40:5,eq=brightness=-0.15[bg];` +
    `[b]scale=${size}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${CLIP_FPS},format=yuv420p[v]`;
  return [
    "-nostdin", "-hide_banner", "-y", "-protocol_whitelist", "file",
    "-ss", c.startS.toFixed(3), "-t", (c.endS - c.startS).toFixed(3), "-i", c.inFile,
    "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-movflags", "+faststart", c.outFile,
  ];
}
