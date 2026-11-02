import { REFRAME_RATIOS, shouldReframe } from "../../../remotion/kit/reframeMath";

// Pure: the "Make 16:9 / 1:1 version" pass. One ffmpeg filter on the finished final.mp4: the picture is scaled to fit,
// the sides are filled with a blurred, dimmed copy of itself (scaled to cover, then cropped). Sound is copied as is.
// final.mp4 is only read; the result is a separate file next to it.
export const REFRAME_FORMATS = ["16x9", "1x1"] as const;
export type ReframeFormat = (typeof REFRAME_FORMATS)[number];
export const isReframeFormat = (v: unknown): v is ReframeFormat => typeof v === "string" && (REFRAME_FORMATS as readonly string[]).includes(v);

export const reframeFileName = (f: ReframeFormat): string => `final-${f}.mp4`;

/** A plain sentence when this video cannot be re-framed, else null. Collage shots lay out against the frame size. */
export function reframeProblem(kind: string, sceneKinds: readonly string[]): string | null {
  return shouldReframe({ kinds: kind === "collage" ? ["collage", ...sceneKinds] : [...sceneKinds] }) ? null : "This video uses collage shots, which cannot be re-framed.";
}

export function reframeArgs(format: ReframeFormat, inFile: string, outFile: string): string[] {
  const { width: w, height: h } = REFRAME_RATIOS[format];
  const graph =
    `[0:v]split=2[a][b];` +
    `[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=40:5,eq=brightness=-0.25[bg];` +
    `[b]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`;
  return [
    "-nostdin", "-hide_banner", "-y", "-protocol_whitelist", "file", "-i", inFile,
    "-filter_complex", graph, "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", outFile,
  ];
}
