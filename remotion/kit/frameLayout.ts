// Pure per-layout numbers and long-form helpers (unit-tested; no Remotion imports).
// Portrait is read straight from the theme, so shorts keep today's numbers.
import { defaultTheme } from "./theme";
import { docFrames } from "./timeline";

export type Layout = "portrait" | "landscape";

export type FrameLayout = {
  width: number;
  height: number;
  safe: { top: number; bottom: number; side: number };
  captionFont: number;
  captionMaxChars: number;
  /** Distance (px) from the frame bottom where captions end; lower thirds sit above it. */
  captionBottom: number;
  titleFont: number;
  bodyFont: number;
};

const PORTRAIT: FrameLayout = {
  width: defaultTheme.width,
  height: defaultTheme.height,
  safe: defaultTheme.safe,
  captionFont: 68, // Captions.tsx FONT
  captionMaxChars: defaultTheme.copy.maxCharsPerLine,
  captionBottom: defaultTheme.safe.bottom,
  titleFont: defaultTheme.type.title,
  bodyFont: defaultTheme.type.body,
};

// No phone UI covers a 16:9 frame, so the margins are small and lines are wide.
const LANDSCAPE: FrameLayout = {
  width: 1920,
  height: 1080,
  safe: { top: 90, bottom: 110, side: 120 },
  captionFont: 54,
  captionMaxChars: 56,
  captionBottom: 110,
  titleFont: 96,
  bodyFont: 44,
};

export const frameLayout = (l: Layout): FrameLayout => (l === "landscape" ? LANDSCAPE : PORTRAIT);

/** Where the portrait scene stage (1080x1920, scaled to full height) sits in the landscape frame. `left`/`top` place the unscaled box; the transform scales around its centre. */
export function stageGeometry() {
  return { scale: LANDSCAPE.height / PORTRAIT.height, left: (LANDSCAPE.width - PORTRAIT.width) / 2, top: (LANDSCAPE.height - PORTRAIT.height) / 2 };
}

export type Chapter = { title: string; startMs: number };

/** Index of the chapter playing at `ms`, or -1 when there are none. Chapters must be sorted by start. */
export function activeChapter(chapters: readonly Chapter[], ms: number): number {
  let at = -1;
  chapters.forEach((c, i) => {
    if (ms >= c.startMs) at = i;
  });
  return at;
}

/** One bar segment per chapter, sized by chapter length; `fill` is how much of it has played (0..1). */
export function progressSegments(chapters: readonly Chapter[], totalMs: number, nowMs: number): { weight: number; fill: number }[] {
  const total = Math.max(1, totalMs);
  if (!chapters.length) return [{ weight: 1, fill: Math.min(1, Math.max(0, nowMs / total)) }];
  const len = chapters.map((c, i) => Math.max(1, (chapters[i + 1]?.startMs ?? total) - c.startMs));
  const unit = Math.min(...len);
  return chapters.map((c, i) => ({ weight: len[i]! / unit, fill: Math.min(1, Math.max(0, (nowMs - c.startMs) / len[i]!)) }));
}

export const CHAPTER_CARD_MS = 3000;

/** Frames the title card of chapter `i` stays up: 3 s, never longer than the chapter itself. */
export function chapterCardFrames(chapters: readonly Chapter[], i: number, totalMs: number, fps: number): number {
  const len = (chapters[i + 1]?.startMs ?? totalMs) - chapters[i]!.startMs;
  return Math.max(1, Math.round((Math.min(CHAPTER_CARD_MS, len) / 1000) * fps));
}

/** 0 at both ends of the window, 1 in the middle; a 12-frame ramp each side. */
export const lowerThirdOpacity = (local: number, duration: number): number => Math.max(0, Math.min(1, local / 12, (duration - local) / 12));

/** Sizes (px) for the long-form blocks, per layout. */
export function blockSizes(l: Layout) {
  const f = frameLayout(l);
  const land = l === "landscape";
  return {
    cardTitle: f.titleFont,
    cardKicker: land ? 36 : 40,
    thirdFont: land ? 44 : 46,
    thirdSub: land ? 30 : 32,
    // Sits above the caption band, inside the side margins.
    thirdBottom: f.captionBottom + (land ? 150 : 40),
    thirdLeft: f.safe.side,
    barHeight: land ? 8 : 10,
    barGap: 6,
    barSide: f.safe.side,
    barBottom: land ? 40 : f.safe.bottom - 80,
  };
}

/** Landscape video length in frames, from the scenes alone (same rule as the portrait one). */
export const landscapeFrames = (scenes: readonly { startMs: number; durationMs: number }[], fps: number): number => docFrames(scenes, fps);
