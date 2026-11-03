// Style presets as plain data (no React, no IO): shared by the app (form, Build prompt) and Remotion (render, preview).
// Idea-level recipes only. Every font named here is vendored in infra/render/fonts (the render image has no network).
import { defaultTheme } from "./theme";
import type { Look } from "./look";
import { TRANSITION_FRAMES, type CaptionWord } from "./timeline";

/** The ten styles the picker offers (and the only ids a new video may choose). */
export const STYLE_IDS = [
  "clean_professional", "flat_motion", "minimal_diagram", "premium_editorial", "storybook_calm",
  "paper_cutout", "kinetic_type", "retention_shorts", "wrapped_stats", "ai_studio",
] as const;
export type StyleId = (typeof STYLE_IDS)[number];
/** Ids saved by older videos. Still render; never offered. `legacy_default` is today's look (what null means). */
export const LEGACY_STYLE_IDS = ["legacy_default", "clean_pro", "neon_flat", "blueprint_whiteboard", "documentary_montage"] as const;
export type LegacyStyleId = (typeof LEGACY_STYLE_IDS)[number];
export type AnyStyleId = StyleId | LegacyStyleId;
export const CAPTION_STYLE_IDS = ["punchy_captions"] as const;
export type CaptionStyleId = (typeof CAPTION_STYLE_IDS)[number];
/** What a video with no style (null) uses: today's look, unchanged. */
export const DEFAULT_STYLE: AnyStyleId = "legacy_default";

export type CaptionStyle = {
  /** "pill" = the karaoke block under the scene area; "paged" = a few big outlined words; "tags" = one tilted paper tag per word; "kinetic" = big staggered words. */
  layout: "pill" | "paged" | "tags" | "kinetic";
  wordsPerPage: number;
  /** "look" = the video's accent colour. */
  activeColor: string;
  outlinePx: number;
  /** Where the text block starts, as a share of the frame height. Pill ignores it (it follows the safe area). */
  topPct: number;
  fontSize: number;
  /** Pill only; all absent = today's dark pill with white text. */
  pillBg?: string;
  textColor?: string;
  align?: "left" | "center";
  glow?: string;
  /** Latin font family for the tags / kinetic / pill text. Absent = the theme UI font. */
  font?: string;
};

export type StylePreset = {
  id: AnyStyleId;
  label: string;
  mood: string;
  /** Picker line, e.g. "Finance, how-it-works". */
  bestFor?: string;
  /** The owner-approved palette (page first), shown as the swatch strip and mock frame in the picker. Light styles show their real light colours here. */
  sheet?: readonly string[];
  /** null = today's behaviour: the gradient is picked from the video seed. */
  look: Look | null;
  /** Scene-kit pieces draw light text, so light styles use their ink-on-night twin here. */
  palette: { bg: string; surface: string; text: string; muted: string; accent: string; accent2?: string; chart: readonly string[] };
  fonts: { heading: string; body: string; mono?: string; headingWeight: number; bodyWeight?: number };
  /** `scaleFrom` = start size that settles to 1 (a pop or a punch-in); `rise` = px of drift. */
  motion: { kind: "smooth" | "spring"; stiffness: number; damping: number; transitionFrames: number; rise: number; scaleFrom?: number };
  pacing: { minHoldFrames: number; maxHoldFrames: number; cutRhythm: "even" | "uneven" };
  captions: CaptionStyle;
  /** Picture scenes only: slow push-in (share of the frame, over the scene) and a dark vignette strength. Absent = untouched. */
  grade?: { pushIn: number; vignette: number };
  /** Extra frame effects drawn over every scene (see StyleFx). Absent = none. */
  fx?: { grain?: boolean; vignette?: number; glowDots?: boolean; boilBanner?: boolean };
  /** Pictures stage asks for a video clip on every beat (the clip cap still applies) and may keep this many clips. */
  clips?: { wantAll: boolean; max: number };
  preferKinds: readonly string[];
  avoidKinds: readonly string[];
  antiPatterns: readonly string[];
};

const p = defaultTheme.palette;

const PILL: CaptionStyle = { layout: "pill", wordsPerPage: 6, activeColor: "look", outlinePx: 0, topPct: 0, fontSize: 68 };
const NO_PILL = { pillBg: "transparent" } as const;

const LEGACY: Record<Exclude<LegacyStyleId, "clean_pro">, StylePreset> = {
  // Today's look, unchanged: per-video gradient, Inter, 8-frame fade-up, pill captions.
  legacy_default: {
    id: "legacy_default",
    label: "Classic",
    mood: "Calm, steady, trustworthy. The original look, with a new colour mix for every video.",
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
  documentary_montage: {
    id: "documentary_montage",
    label: "Documentary montage",
    mood: "Dark, cinematic, quiet. Slow push-ins on real footage, few title cards.",
    look: { name: "documentary", from: "#0a0a0d", to: "#1b1612", accent: "#e8c07a", accent2: "#d6d3d1" },
    palette: { bg: "#0a0a0d", surface: "#1b1612", text: "#f5f5f4", muted: "#a8a29e", accent: "#e8c07a", chart: ["#e8c07a", "#f5f5f4", "#a8a29e", "#d6a05c", "#78716c", "#fde7b0"] },
    fonts: { heading: defaultTheme.fonts.ui, body: defaultTheme.fonts.ui, headingWeight: 600 },
    motion: { kind: "smooth", stiffness: 0, damping: 0, transitionFrames: 12, rise: 8 },
    pacing: { minHoldFrames: 36, maxHoldFrames: 120, cutRhythm: "uneven" },
    captions: PILL,
    grade: { pushIn: 0.05, vignette: 0.45 },
    clips: { wantAll: true, max: 6 },
    preferKinds: ["stock_clip", "story_kenburns"],
    avoidKinds: [],
    antiPatterns: ["more than 25% of scenes as text cards (pause_card, hook titles)", "holding one clip longer than 4 seconds or cutting faster than 1.2 seconds; serious beats hold longer, light beats shorter", "bright colours or busy graphics over footage"],
  },
  blueprint_whiteboard: {
    id: "blueprint_whiteboard",
    label: "Blueprint whiteboard",
    mood: "Slow, exact, drawn by hand. Blueprint blue paper, white lines, one amber accent.",
    look: { name: "blueprint", from: "#0c2340", to: "#10294a", accent: "#fbbf24", accent2: "#fbbf24" },
    palette: { bg: "#0c2340", surface: "#12315a", text: "#f8fafc", muted: "#a9bbd3", accent: "#fbbf24", chart: ["#fbbf24", "#f8fafc", "#93c5fd", "#a9bbd3", "#fcd34d", "#bfdbfe"] },
    fonts: { heading: defaultTheme.fonts.ui, body: defaultTheme.fonts.ui, headingWeight: 600 },
    motion: { kind: "smooth", stiffness: 0, damping: 0, transitionFrames: 12, rise: 12 },
    pacing: { minHoldFrames: 90, maxHoldFrames: 450, cutRhythm: "even" },
    captions: PILL,
    preferKinds: ["svg_diagram", "drawn_objects", "algo_cells", "network", "chart"],
    avoidKinds: [],
    antiPatterns: ["photos or stock clips unless the beat truly needs one", "more than one accent colour", "bouncy or springy motion; strokes draw in at a steady pace, one at a time"],
  },
};

// The three light styles (1, 3, 4) have a paper look in the owner's sheet (`sheet`). The scene-kit pieces paint light text, so their
// `palette`/`look` are the night-ink twin: same accents and fonts on a deep background. The Custom animation PR can use `sheet` as is.
export const PRESETS: Record<AnyStyleId, StylePreset> = {
  ...LEGACY,
  clean_pro: LEGACY.legacy_default, // the old id for today's look
  clean_professional: {
    id: "clean_professional",
    label: "Clean Professional",
    mood: "Calm, trustworthy, lots of white space.",
    bestFor: "Finance, how-it-works, trust",
    sheet: ["#FFFFFF", "#1F2937", "#2563EB", "#F59E0B"],
    look: { name: "clean-professional", from: "#0b1730", to: "#12264a", accent: "#f59e0b", accent2: "#60a5fa" },
    palette: { bg: "#0b1730", surface: "#14233f", text: "#f8fafc", muted: "#a9b6cc", accent: "#f59e0b", accent2: "#60a5fa", chart: ["#60a5fa", "#f59e0b", "#34d399", "#f8fafc", "#a9b6cc", "#93c5fd"] },
    fonts: { heading: "Inter", body: "Inter", mono: "JetBrains Mono", headingWeight: 800, bodyWeight: 400 },
    motion: { kind: "smooth", stiffness: 0, damping: 0, transitionFrames: 12, rise: 16, scaleFrom: 0.95 },
    pacing: { minHoldFrames: 75, maxHoldFrames: 360, cutRhythm: "even" },
    captions: { ...PILL, wordsPerPage: 4, pillBg: "rgba(243,244,246,0.94)", textColor: "#1f2937", activeColor: "#2563eb" },
    preferKinds: ["chart", "browser", "network", "drawn_objects", "spreadsheet"],
    avoidKinds: [],
    antiPatterns: ["bounce or springy motion", "more than three colours on one screen", "cutting a scene shorter than 2 seconds"],
  },
  flat_motion: {
    id: "flat_motion",
    label: "Flat Motion",
    mood: "Fast, bold, bouncy tech energy.",
    bestFor: "Tech, AI, startups, hot takes",
    sheet: ["#0F172A", "#F8FAFC", "#7C3AED", "#EC4899", "#22D3EE"],
    look: { name: "flat-motion", from: "#0f172a", to: "#1e1b4b", accent: "#22d3ee", accent2: "#ec4899" },
    palette: { bg: "#0f172a", surface: "#1e293b", text: "#f8fafc", muted: "#94a3b8", accent: "#7c3aed", accent2: "#ec4899", chart: ["#7c3aed", "#22d3ee", "#ec4899", "#facc15", "#34d399", "#fb923c"] },
    fonts: { heading: "Space Grotesk", body: "Space Grotesk", mono: "JetBrains Mono", headingWeight: 700, bodyWeight: 300 },
    motion: { kind: "spring", stiffness: 80, damping: 10, transitionFrames: 9, rise: 48, scaleFrom: 0.8 },
    pacing: { minHoldFrames: 45, maxHoldFrames: 240, cutRhythm: "uneven" },
    captions: { ...PILL, wordsPerPage: 4, activeColor: "#22d3ee", font: "Space Grotesk" },
    preferKinds: ["chart", "network", "algo_cells", "terminal", "orbit"],
    avoidKinds: [],
    antiPatterns: ["slow fades; things should pop in", "serif type", "pale or washed-out colours", "more than three bright colours on one screen"],
  },
  minimal_diagram: {
    id: "minimal_diagram",
    label: "Minimal Diagram",
    mood: "Exact, quiet, drawn by a steady hand.",
    bestFor: "How it works, maths, coding",
    sheet: ["#FAFAFA", "#1A1A2E", "#E94560"],
    look: { name: "minimal-diagram", from: "#1a1a2e", to: "#1a1a2e", accent: "#f25f78", accent2: "#f25f78" },
    palette: { bg: "#1a1a2e", surface: "#242442", text: "#fafafa", muted: "#a8a8be", accent: "#f25f78", accent2: "#f25f78", chart: ["#f25f78", "#fafafa", "#a8a8be", "#d4d4e2", "#7c7c98", "#fda4b3"] },
    fonts: { heading: "IBM Plex Sans", body: "IBM Plex Sans", mono: "IBM Plex Mono", headingWeight: 600, bodyWeight: 400 },
    motion: { kind: "smooth", stiffness: 0, damping: 0, transitionFrames: 15, rise: 0 },
    pacing: { minHoldFrames: 90, maxHoldFrames: 450, cutRhythm: "even" },
    captions: { ...PILL, ...NO_PILL, wordsPerPage: 5, textColor: "#fafafa", font: "IBM Plex Mono" },
    preferKinds: ["svg_diagram", "math", "algo_cells", "network", "drawn_objects", "chart"],
    avoidKinds: ["stock_clip", "story_kenburns"],
    antiPatterns: ["bounce or springy motion", "a second accent colour; one accent only", "gradients", "photos unless the beat truly needs one"],
  },
  premium_editorial: {
    id: "premium_editorial",
    label: "Premium Editorial",
    mood: "Magazine calm: one big idea per frame.",
    bestFor: "Premium explainers, ideas",
    sheet: ["#F9FAFB", "#111827", "#2563EB", "#0D9488"],
    look: { name: "premium-editorial", from: "#111827", to: "#111827", accent: "#60a5fa", accent2: "#2dd4bf" },
    palette: { bg: "#111827", surface: "#1b2436", text: "#f9fafb", muted: "#9ca3af", accent: "#60a5fa", accent2: "#2dd4bf", chart: ["#60a5fa", "#2dd4bf", "#f9fafb", "#9ca3af", "#93c5fd", "#99f6e4"] },
    fonts: { heading: "Inter", body: "Inter", mono: "IBM Plex Mono", headingWeight: 800, bodyWeight: 500 },
    motion: { kind: "smooth", stiffness: 0, damping: 0, transitionFrames: 14, rise: 12 },
    pacing: { minHoldFrames: 83, maxHoldFrames: 360, cutRhythm: "even" },
    captions: { ...PILL, ...NO_PILL, wordsPerPage: 5, align: "left", fontSize: 60 },
    preferKinds: ["chart", "pause_card", "story_kenburns", "drawn_objects"],
    avoidKinds: [],
    antiPatterns: ["gradients", "generic blue cards", "fast kinetic cuts", "more than one big idea per scene"],
  },
  storybook_calm: {
    id: "storybook_calm",
    label: "Storybook Calm",
    mood: "Slow, warm, wonder at night.",
    bestFor: "Stories, science wonder",
    sheet: ["#0A0A1A", "#F5F0E8", "#FFB347", "#2F6B4F"],
    look: { name: "storybook-calm", from: "#0a0a1a", to: "#1a1740", accent: "#ffb347", accent2: "#2f6b4f" },
    palette: { bg: "#0a0a1a", surface: "#161630", text: "#f5f0e8", muted: "#b5afa3", accent: "#ffb347", accent2: "#2f6b4f", chart: ["#ffb347", "#f5f0e8", "#7fc4a0", "#b5afa3", "#ffe9b5", "#9b7cc4"] },
    fonts: { heading: "Noto Serif", body: "Noto Serif", mono: "IBM Plex Mono", headingWeight: 600, bodyWeight: 300 },
    motion: { kind: "spring", stiffness: 40, damping: 14, transitionFrames: 30, rise: 8 },
    pacing: { minHoldFrames: 105, maxHoldFrames: 210, cutRhythm: "even" },
    captions: { ...PILL, ...NO_PILL, wordsPerPage: 5, textColor: "#f5f0e8", glow: "rgba(255,179,71,0.6)", font: "Noto Serif", fontSize: 60 },
    fx: { vignette: 0.5, glowDots: true },
    preferKinds: ["story_kenburns", "orbit", "drawn_objects", "map"],
    avoidKinds: ["terminal", "algo_cells"],
    antiPatterns: ["fast cuts", "neon colours", "sans-serif headlines", "hard bounce"],
  },
  paper_cutout: {
    id: "paper_cutout",
    label: "Paper Cutout",
    mood: "Stop-motion paper, tactile and loud in a good way.",
    bestFor: "The most distinctive Shorts look",
    sheet: ["#132124", "#DACEC0", "#D67354", "#C9573C", "#2DA34D"],
    look: { name: "paper-cutout", from: "#132124", to: "#132124", accent: "#d67354", accent2: "#c9573c" },
    palette: { bg: "#132124", surface: "#1f3236", text: "#dacec0", muted: "#a89e92", accent: "#d67354", accent2: "#c9573c", chart: ["#d67354", "#dacec0", "#2da34d", "#c9573c", "#8a7a60", "#f0b27a"] },
    fonts: { heading: "Archivo Black", body: "Fraunces", mono: "IBM Plex Mono", headingWeight: 400, bodyWeight: 600 },
    motion: { kind: "spring", stiffness: 140, damping: 12, transitionFrames: 4, rise: 0, scaleFrom: 0.85 },
    pacing: { minHoldFrames: 54, maxHoldFrames: 90, cutRhythm: "uneven" },
    captions: { layout: "tags", wordsPerPage: 1, activeColor: "#c9573c", outlinePx: 0, topPct: 0.7, fontSize: 84, textColor: "#f3e6d3", font: "Fraunces" },
    fx: { grain: true, boilBanner: true },
    preferKinds: ["drawn_objects", "chart", "pause_card", "orbit"],
    avoidKinds: [],
    antiPatterns: ["gradients", "smooth glossy shading", "long still frames; something changes every 1.8 to 3 seconds", "soft fades; scenes cut hard"],
  },
  kinetic_type: {
    id: "kinetic_type",
    label: "Kinetic Type",
    mood: "The words are the picture.",
    bestFor: "Facts, quotes, any subject",
    sheet: ["#0B0B0F", "#FFFFFF", "#FFE45E", "#FF4D6D"],
    look: { name: "kinetic-type", from: "#0b0b0f", to: "#0b0b0f", accent: "#ffe45e", accent2: "#ff4d6d" },
    palette: { bg: "#0b0b0f", surface: "#17171f", text: "#ffffff", muted: "#a1a1aa", accent: "#ffe45e", accent2: "#ff4d6d", chart: ["#ffe45e", "#ff4d6d", "#ffffff", "#a1a1aa", "#fde68a", "#fda4af"] },
    fonts: { heading: "Archivo Black", body: "Space Grotesk", mono: "JetBrains Mono", headingWeight: 400, bodyWeight: 500 },
    motion: { kind: "smooth", stiffness: 0, damping: 0, transitionFrames: 6, rise: 24 },
    pacing: { minHoldFrames: 36, maxHoldFrames: 90, cutRhythm: "uneven" },
    captions: { layout: "kinetic", wordsPerPage: 3, activeColor: "#ffe45e", outlinePx: 0, topPct: 0.3, fontSize: 150, font: "Archivo Black" },
    preferKinds: ["pause_card", "chart", "drawn_objects"],
    avoidKinds: ["stock_clip", "story_kenburns", "collage"],
    antiPatterns: ["photos", "small text", "many objects on one screen"],
  },
  retention_shorts: {
    id: "retention_shorts",
    label: "Retention Shorts",
    mood: "Built to keep people watching.",
    bestFor: "Maximum watch time",
    sheet: ["#111827", "#1D4ED8", "#FFE45E", "#000000"],
    look: { name: "retention-shorts", from: "#111827", to: "#1d4ed8", accent: "#ffe45e", accent2: "#93c5fd" },
    palette: { bg: "#111827", surface: "#1e293b", text: "#ffffff", muted: "#cbd5e1", accent: "#ffe45e", accent2: "#60a5fa", chart: ["#ffe45e", "#60a5fa", "#ffffff", "#f472b6", "#34d399", "#cbd5e1"] },
    fonts: { heading: "Poppins", body: "Poppins", mono: "JetBrains Mono", headingWeight: 800, bodyWeight: 600 },
    motion: { kind: "spring", stiffness: 260, damping: 9, transitionFrames: 5, rise: 24, scaleFrom: 1.1 },
    pacing: { minHoldFrames: 60, maxHoldFrames: 120, cutRhythm: "uneven" },
    captions: { layout: "paged", wordsPerPage: 3, activeColor: "#ffe45e", outlinePx: 6, topPct: 0.65, fontSize: 84, font: "Poppins" },
    preferKinds: ["chart", "pause_card", "drawn_objects", "chat_thread"],
    avoidKinds: [],
    antiPatterns: ["fading up from black", "cutting at an even rhythm", "an empty first frame; the hook shows at once", "slow build-ups before the point"],
  },
  wrapped_stats: {
    id: "wrapped_stats",
    label: "Wrapped Stats",
    mood: "Numbers as a story that builds.",
    bestFor: "Data and ranking Shorts",
    sheet: ["#0B1020", "#FDE047", "#F472B6", "#34D399"],
    look: { name: "wrapped-stats", from: "#0b1020", to: "#1f1450", accent: "#fde047", accent2: "#f472b6" },
    palette: { bg: "#0b1020", surface: "#151b33", text: "#ffffff", muted: "#a5b0cc", accent: "#fde047", accent2: "#f472b6", chart: ["#fde047", "#f472b6", "#34d399", "#60a5fa", "#fb923c", "#c4b5fd"] },
    fonts: { heading: "Poppins", body: "Space Grotesk", mono: "JetBrains Mono", headingWeight: 800, bodyWeight: 600 },
    motion: { kind: "spring", stiffness: 100, damping: 14, transitionFrames: 8, rise: 32 },
    pacing: { minHoldFrames: 60, maxHoldFrames: 150, cutRhythm: "even" },
    captions: { ...PILL, wordsPerPage: 4, activeColor: "#fde047", font: "Space Grotesk" },
    preferKinds: ["chart", "spreadsheet", "pause_card", "probability"],
    avoidKinds: ["stock_clip"],
    antiPatterns: ["opening on the biggest number; build up to it", "list items entering at different speeds", "more than one highlighted number per scene"],
  },
  ai_studio: {
    id: "ai_studio",
    label: "AI Studio",
    mood: "Airy, premium glow with big drawn objects.",
    bestFor: "Explainers with big drawn objects",
    sheet: ["#0E1226", "#6366F1", "#9B7CC4", "#4DB8A8", "#F5D76E"],
    look: { name: "ai-studio", from: "#0e1226", to: "#161a3a", accent: "#f5d76e", accent2: "#6366f1" },
    palette: { bg: "#0e1226", surface: "#171c38", text: "#ffffff", muted: "#a9b0cc", accent: "#f5d76e", accent2: "#6366f1", chart: ["#f5d76e", "#6366f1", "#4db8a8", "#9b7cc4", "#ffffff", "#a9b0cc"] },
    fonts: { heading: "Space Grotesk", body: "Inter", mono: "JetBrains Mono", headingWeight: 700, bodyWeight: 400 },
    motion: { kind: "smooth", stiffness: 0, damping: 0, transitionFrames: 18, rise: 20 },
    pacing: { minHoldFrames: 90, maxHoldFrames: 360, cutRhythm: "even" },
    captions: { ...PILL, activeColor: "#f5d76e", font: "Inter" },
    preferKinds: ["drawn_objects", "orbit", "network", "chart"],
    avoidKinds: [],
    antiPatterns: ["loud cartoon bounce", "hard shadows", "text-only scenes"],
  },
};

/** Retention captions: 1-3 word pages, yellow active word, black outline, about 65% down. Works on top of any preset. */
export const CAPTION_STYLES: Record<CaptionStyleId, CaptionStyle> = {
  punchy_captions: { layout: "paged", wordsPerPage: 3, activeColor: "#ffe45e", outlinePx: 6, topPct: 0.65, fontSize: 84 },
};

export const isStyleId = (v: unknown): v is AnyStyleId => typeof v === "string" && ((STYLE_IDS as readonly string[]).includes(v) || (LEGACY_STYLE_IDS as readonly string[]).includes(v));
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
  if (!isStyleId(id) || PRESETS[id] === PRESETS[DEFAULT_STYLE]) return "";
  const s = PRESETS[id];
  const lines = [`Video style: ${s.label} (${s.mood})`];
  if (s.preferKinds.length) lines.push(`Prefer these kinds when they fit the beat: ${s.preferKinds.join(", ")}.`);
  if (s.avoidKinds.length) lines.push(`Avoid these kinds: ${s.avoidKinds.join(", ")}.`);
  if (s.antiPatterns.length) lines.push(`Never: ${s.antiPatterns.join("; ")}.`);
  const isNew = (STYLE_IDS as readonly string[]).includes(s.id);
  const rhythm = isNew && s.pacing.cutRhythm === "uneven" ? " Vary the lengths; never give two neighbouring scenes the same length." : "";
  lines.push(`Pace: scenes usually hold ${(s.pacing.minHoldFrames / 30).toFixed(1)} to ${(s.pacing.maxHoldFrames / 30).toFixed(1)} seconds.${rhythm}`);
  return lines.join("\n");
}

/** Extra parts for a stage's input hash. Empty when nothing was chosen, so hashes made before styles existed stay identical. */
export function styleHashParts(style: string | null | undefined, captionStyle: string | null | undefined): Record<string, string> {
  return { ...(style ? { style } : {}), ...(captionStyle ? { caption_style: captionStyle } : {}) };
}
