// The AI-clip bake-off grid (Phase 8.11): the same prompt made by several video models, shown side by side, each panel labelled with the model and what
// it cost. Pure rules: layout, labels, the ffmpeg filter graph. No IO. The cost shown is what the app recorded for that clip, never a guess.
import { microToDollars } from "@/server/core/spend";

export const MAX_PANELS = 6;
export const MIN_PANELS = 2;
export const PANEL = { width: 360, height: 640 } as const;
export const LABEL_HEIGHT = 96;

export interface Panel {
  file: string;
  /** The model's name as the owner knows it. */
  label: string;
  /** What this clip cost, whole micro-USD; null = not known (shown as "cost not recorded", never as free). */
  costMicroUsd: number | null;
}

export type GridProblem = string;

const SAFE_LABEL = /^[\p{L}\p{N} ._:+()\/-]{1,60}$/u;

/** Why these panels cannot be compared, or null. */
export function gridProblem(panels: readonly Panel[]): GridProblem | null {
  if (panels.length < MIN_PANELS) return `Compare at least ${MIN_PANELS} clips.`;
  if (panels.length > MAX_PANELS) return `Compare at most ${MAX_PANELS} clips at a time.`;
  for (const p of panels) {
    if (!/\.(mp4|mov)$/i.test(p.file)) return "Every clip must be an MP4 or MOV file.";
    if (!SAFE_LABEL.test(p.label)) return "A label is 1 to 60 letters, digits, spaces or . _ : + ( ) / -";
    if (p.costMicroUsd !== null && (!Number.isSafeInteger(p.costMicroUsd) || p.costMicroUsd < 0)) return "A cost must be a whole number of micro-dollars, 0 or more.";
  }
  return null;
}

/** Columns and rows: two across up to four clips, three across after that. */
export function gridShape(n: number): { cols: number; rows: number } {
  const cols = n <= 4 ? 2 : 3;
  return { cols, rows: Math.ceil(n / cols) };
}

/** The two lines under each panel. */
export function labelLines(p: Panel): [string, string] {
  return [p.label, p.costMicroUsd === null ? "cost not recorded" : `${microToDollars(p.costMicroUsd)} for this clip`];
}

/** The cheapest known cost among the panels, and which panels share it, so the grid can say who was cheapest (unknown costs never win). */
export function cheapest(panels: readonly Panel[]): number[] {
  const known = panels.map((p, i) => [p.costMicroUsd, i] as const).filter((x): x is readonly [number, number] => x[0] !== null);
  if (known.length === 0) return [];
  const min = Math.min(...known.map((x) => x[0]));
  return known.filter((x) => x[0] === min).map((x) => x[1]);
}

/**
 * ffmpeg arguments: every clip is scaled to fit its panel (never stretched) and padded, its label image sits on the bottom strip, and the panels are
 * stacked. Audio is dropped (the clips carry none we want). The grid ends when the shortest clip ends.
 * Inputs are the clips first (0..n-1), then the label images (n..2n-1).
 */
export function gridArgs(panels: readonly Panel[], labelFiles: readonly string[], out: string): string[] {
  const problem = gridProblem(panels);
  if (problem) throw new RangeError(problem);
  if (labelFiles.length !== panels.length) throw new RangeError("one label image per clip");
  const n = panels.length;
  const { cols } = gridShape(n);
  const { width: w, height: h } = PANEL;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[v${i}]`);
    parts.push(`[v${i}][${n + i}:v]overlay=0:${h - LABEL_HEIGHT}:format=auto:shortest=1[p${i}]`);
  }
  const layout = panels.map((_, i) => `${(i % cols) * w}_${Math.floor(i / cols) * h}`).join("|");
  parts.push(`${panels.map((_, i) => `[p${i}]`).join("")}xstack=inputs=${n}:layout=${layout}:shortest=1:fill=black[grid]`);
  return [
    "-y", "-v", "error",
    ...panels.flatMap((p) => ["-i", p.file]),
    ...labelFiles.flatMap((f) => ["-loop", "1", "-i", f]),
    "-filter_complex", parts.join(";"),
    "-map", "[grid]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "-shortest",
    out,
  ];
}
