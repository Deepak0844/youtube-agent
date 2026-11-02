// Style presets as plain data (no React, no IO): shared by the app (form, Build prompt) and Remotion (render, preview).
// Idea-level recipes only. Fonts are ones the render image already carries (Inter, Space Grotesk, JetBrains Mono).
import { defaultTheme } from "./theme";
import type { Look } from "./look";
import { TRANSITION_FRAMES, type CaptionWord } from "./timeline";

export const STYLE_IDS = ["clean_pro", "neon_flat"] as const;
export type StyleId = (typeof STYLE_IDS)[number];
export const CAPTION_STYLE_IDS = ["punchy_captions"] as const;
export type CaptionStyleId = (typeof CAPTION_STYLE_IDS)[number];
export const DEFAULT_STYLE: StyleId = "clean_pro";

export type CaptionStyle = {
  /** "pill" = today's dark pill under the scene area; "paged" = a few big words at a time with an outline. */
  layout: "pill" | "paged";
  wordsPerPage: number;
  /** "look" = the video's accent colour. */
  activeColor: string;
  outlinePx: number;
  /** Where the text block starts, as a share of the frame height. Pill ignores it (it follows the safe area). */
  topPct: number;
  fontSize: number;
};

export type StylePreset = {
  id: StyleId;
  label: string;
  mood: string;
  /** null = today's behaviour: the gradient is picked from the video seed. */
  look: Look | null;
  palette: { bg: string; surface: string; text: string; muted: string; accent: string; chart: readonly string[] };
  fonts: { heading: string; body: string; headingWeight: number };
  motion: { kind: "smooth" | "spring"; stiffness: number; damping: number; transitionFrames: number; rise: number };
  pacing: { minHoldFrames: number; maxHoldFrames: number; cutRhythm: "even" | "uneven" };
  captions: CaptionStyle;
  preferKinds: readonly string[];
  avoidKinds: readonly string[];
  antiPatterns: readonly string[];
};

const p = defaultTheme.palette;

const PILL: CaptionStyle = { layout: "pill", wordsPerPage: 6, activeColor: "look", outlinePx: 0, topPct: 0, fontSize: 68 };

export const PRESETS: Record<StyleId, StylePreset> = {
  // Today's look, unchanged: per-video gradient, Inter, 8-frame fade-up, pill captions.
  clean_pro: {
    id: "clean_pro",
    label: "Clean pro",
    mood: "Calm, steady, trustworthy. The default look.",
    look: null,
    palette: { bg: p.bg, surface: p.surface, text: p.text, muted: p.muted, accent: p.accent, chart: p.chart },
    fonts: { heading: defaultTheme.fonts.ui, body: defaultTheme.fonts.ui, headingWeight: 900 },
    motion: { kind: "smooth", stiffness: 0, damping: 0, transitionFrames: TRANSITION_FRAMES, rise: 48 },
    pacing: { minHoldFrames: 75, maxHoldFrames: 360, cutRhythm: "even" },
    captions: PILL,
    preferKinds: [],
    avoidKinds: [],
    antiPatterns: [],
  },
  neon_flat: {
    id: "neon_flat",
    label: "Neon flat",
    mood: "Fast, bouncy, techy. Dark navy with purple and cyan.",
    look: { name: "neon-flat", from: "#0f172a", to: "#2e1065", accent: "#22d3ee", accent2: "#c4b5fd" },
    palette: { bg: "#0f172a", surface: "#1e293b", text: "#f8fafc", muted: "#94a3b8", accent: "#a78bfa", chart: ["#a78bfa", "#22d3ee", "#f472b6", "#facc15", "#34d399", "#fb923c"] },
    fonts: { heading: "Space Grotesk", body: "Space Grotesk", headingWeight: 700 },
    motion: { kind: "spring", stiffness: 80, damping: 10, transitionFrames: 9, rise: 64 },
    pacing: { minHoldFrames: 45, maxHoldFrames: 240, cutRhythm: "uneven" },
    captions: { ...PILL, wordsPerPage: 4 },
    preferKinds: ["chart", "network", "algo_cells", "terminal", "orbit"],
    avoidKinds: [],
    antiPatterns: ["long text slides with no motion", "calm fades; things should pop in", "more than three bright colours on one screen"],
  },
};

/** Retention captions: 1-3 word pages, yellow active word, black outline, about 65% down. Works on top of any preset. */
export const CAPTION_STYLES: Record<CaptionStyleId, CaptionStyle> = {
  punchy_captions: { layout: "paged", wordsPerPage: 3, activeColor: "#ffe45e", outlinePx: 6, topPct: 0.65, fontSize: 84 },
};

export const isStyleId = (v: unknown): v is StyleId => typeof v === "string" && (STYLE_IDS as readonly string[]).includes(v);
export const isCaptionStyleId = (v: unknown): v is CaptionStyleId => typeof v === "string" && (CAPTION_STYLE_IDS as readonly string[]).includes(v);

/** Unknown or missing ids fall back to the default, so old videos and bad data render as before. */
export const presetOf = (id: string | null | undefined): StylePreset => (isStyleId(id) ? PRESETS[id] : PRESETS[DEFAULT_STYLE]);

/** The caption style to draw: the video's own choice if set, else the preset's. */
export const captionStyleOf = (preset: StylePreset, captionStyle: string | null | undefined): CaptionStyle => (isCaptionStyleId(captionStyle) ? CAPTION_STYLES[captionStyle] : preset.captions);

/** Splits caption words into pages of at most `perPage` words; a page also ends at sentence punctuation or a pause of 0.6 s or more. Returns word indices. */
export function pageWords(words: readonly CaptionWord[], perPage: number): number[][] {
  const max = Math.max(1, Math.floor(perPage));
  const pages: number[][] = [];
  let cur: number[] = [];
  words.forEach((w, i) => {
    cur.push(i);
    const next = words[i + 1];
    if (cur.length >= max || /[.!?]$/.test(w.word.trim()) || (next && next.startS - w.endS >= 0.6)) {
      pages.push(cur);
      cur = [];
    }
  });
  if (cur.length) pages.push(cur);
  return pages;
}

/** Build prompt addendum for a style, or "" for the default (so the default prompt is unchanged). */
export function styleGuidance(id: string | null | undefined): string {
  if (!isStyleId(id) || id === DEFAULT_STYLE) return "";
  const s = PRESETS[id];
  const lines = [`Video style: ${s.label} (${s.mood})`];
  if (s.preferKinds.length) lines.push(`Prefer these kinds when they fit the beat: ${s.preferKinds.join(", ")}.`);
  if (s.avoidKinds.length) lines.push(`Avoid these kinds: ${s.avoidKinds.join(", ")}.`);
  if (s.antiPatterns.length) lines.push(`Never: ${s.antiPatterns.join("; ")}.`);
  lines.push(`Pace: scenes usually hold ${(s.pacing.minHoldFrames / 30).toFixed(1)} to ${(s.pacing.maxHoldFrames / 30).toFixed(1)} seconds.`);
  return lines.join("\n");
}

/** Extra parts for a stage's input hash. Empty when nothing was chosen, so hashes made before styles existed stay identical. */
export function styleHashParts(style: string | null | undefined, captionStyle: string | null | undefined): Record<string, string> {
  return { ...(style ? { style } : {}), ...(captionStyle ? { caption_style: captionStyle } : {}) };
}
