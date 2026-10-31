// Pure layout/motion maths for DrawnObjects and Network (unit-tested; no Remotion imports).
import { theme } from "./theme";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const SLOT_X = { left: 270, center: 540, right: 810 } as const;

/** Row centres for n objects stacked inside the safe area, plus the row height. */
export function objectRows(n: number, slot: keyof typeof SLOT_X): { x: number; ys: number[]; rowH: number } {
  const top = theme.safe.top;
  const rowH = (theme.height - theme.safe.bottom - top) / Math.max(1, n);
  return { x: SLOT_X[slot], ys: Array.from({ length: n }, (_, i) => top + rowH * (i + 0.5)), rowH };
}

/** 0..1 entrance progress for item `index`, staggered 8 frames apart, taking 12 frames. */
export function enterProgress(frame: number, index: number): number {
  return clamp01((frame - index * 8) / 12);
}

/** Opacity, scale and y offset (px) for an entrance style at progress p. */
export function enterStyle(kind: "fade" | "pop" | "slide_up", p: number): { opacity: number; scale: number; dy: number } {
  if (kind === "pop") return { opacity: clamp01(p * 3), scale: 0.6 + 0.4 * p, dy: 0 };
  if (kind === "slide_up") return { opacity: p, scale: 1, dy: (1 - p) * 80 };
  return { opacity: p, scale: 1, dy: 0 };
}

/** Looping emphasis: scale and rotation (deg) at `frame`; a one-second cycle. */
export function emphasisStyle(kind: "none" | "pulse" | "wiggle", frame: number, fps = theme.fps): { scale: number; rot: number } {
  const a = (2 * Math.PI * frame) / fps;
  if (kind === "pulse") return { scale: 1 + 0.06 * Math.sin(a), rot: 0 };
  if (kind === "wiggle") return { scale: 1, rot: 4 * Math.sin(a * 2) };
  return { scale: 1, rot: 0 };
}

/** Node centres for the network scene: top to bottom, zig-zag in x so links do not overlap. */
export function networkLayout(n: number): { x: number; y: number }[] {
  const top = theme.safe.top + 100;
  const span = theme.height - theme.safe.bottom - 100 - top;
  return Array.from({ length: n }, (_, i) => ({ x: i % 2 ? 800 : 280, y: n === 1 ? top : top + (span * i) / (n - 1) }));
}

/** Packet position along link `i` of `count` over `total` frames: 0..1 while active, otherwise -1 (hidden). */
export function packetT(frame: number, i: number, count: number, total: number): number {
  const slot = total / Math.max(1, count);
  const t = (frame - i * slot) / (slot * 0.8);
  return t > 0 && t < 1 ? t : -1;
}
