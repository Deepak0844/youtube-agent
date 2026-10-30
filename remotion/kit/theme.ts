// Brand contract for all kit pieces, as plain data (no imports, so the render container can load it).
// Values mirror the old kit's brand.md: calm, premium motion; safe areas for 1080x1920.
export type Bezier = readonly [number, number, number, number];

export type BrandTheme = {
  width: number;
  height: number;
  fps: number;
  palette: Record<"bg" | "surface" | "text" | "muted" | "accent" | "bubbleMe" | "bubbleThem", string>;
  fonts: { ui: string; mono: string };
  /** Named cubic-bezier curves (x1, y1, x2, y2). Feed to Easing.bezier(...curve). */
  easings: Record<"easeOut" | "easeIn" | "easeInOut", Bezier>;
  radii: { card: number; window: number; bubble: number; pill: number };
  /** Keep text inside these margins (px) so platform UI never covers it. */
  safe: { top: number; bottom: number; side: number };
  type: { caption: number; body: number; code: number; title: number };
  /** On-screen copy rules, checked by checkCopy(). */
  copy: { maxCharsPerLine: number; maxLines: number; bannedPhrases: readonly string[] };
};

export const defaultTheme: BrandTheme = {
  width: 1080,
  height: 1920,
  fps: 30,
  palette: {
    bg: "#0b0d12",
    surface: "#161a23",
    text: "#f2f4f8",
    muted: "#8b93a7",
    accent: "#5eead4",
    bubbleMe: "#2563eb",
    bubbleThem: "#252b38",
  },
  fonts: { ui: "Inter", mono: "JetBrains Mono" },
  easings: {
    easeOut: [0.33, 1, 0.68, 1],
    easeIn: [0.32, 0, 0.67, 0],
    easeInOut: [0.37, 0, 0.63, 1],
  },
  radii: { card: 16, window: 10, bubble: 36, pill: 999 },
  safe: { top: 220, bottom: 380, side: 72 },
  type: { caption: 54, body: 46, code: 44, title: 72 },
  copy: {
    maxCharsPerLine: 28,
    maxLines: 3,
    // Engagement-bait outro wording is off-brand on screen.
    bannedPhrases: ["subscribe", "like and subscribe", "follow for more", "smash the like", "comment below", "link in bio"],
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function merge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isObj(base) || !isObj(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(over)) {
    if (!(k in base)) throw new Error(`theme: unknown key "${k}"`);
    out[k] = merge(base[k], over[k]);
  }
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;

function validate(t: BrandTheme): BrandTheme {
  const bad = (m: string) => {
    throw new Error(`theme: ${m}`);
  };
  for (const [k, v] of Object.entries(t.palette)) if (!HEX.test(v)) bad(`palette.${k} must be #rrggbb`);
  for (const [k, v] of Object.entries(t.fonts)) if (!v.trim()) bad(`fonts.${k} is empty`);
  for (const [k, c] of Object.entries(t.easings)) {
    if (c.length !== 4 || c.some((n) => !Number.isFinite(n))) bad(`easings.${k} needs 4 numbers`);
    if (c[0] < 0 || c[0] > 1 || c[2] < 0 || c[2] > 1) bad(`easings.${k} x values must be 0..1`);
  }
  const positive = { width: t.width, height: t.height, fps: t.fps, ...t.radii, ...t.type, ...t.safe, c: t.copy.maxCharsPerLine, l: t.copy.maxLines };
  for (const [k, v] of Object.entries(positive)) if (!Number.isFinite(v) || v < 0) bad(`${k} must be a non-negative number`);
  if (t.safe.top + t.safe.bottom >= t.height || t.safe.side * 2 >= t.width) bad("safe areas leave no room");
  return t;
}

/** Deep-merge a partial theme over the default and validate. Unknown keys and bad values throw. */
export function defineTheme(partial: DeepPartial<BrandTheme> = {}): BrandTheme {
  return validate(merge(defaultTheme, partial) as BrandTheme);
}

/** Problems with one on-screen text block, per the theme's copy rules. Empty array means fine. */
export function checkCopy(text: string, t: BrandTheme = defaultTheme): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  if (lines.length > t.copy.maxLines) out.push(`more than ${t.copy.maxLines} lines`);
  if (lines.some((l) => [...l].length > t.copy.maxCharsPerLine)) out.push(`a line is over ${t.copy.maxCharsPerLine} characters`);
  const low = text.toLowerCase();
  for (const p of t.copy.bannedPhrases) if (low.includes(p)) out.push(`banned phrase "${p}"`);
  return out;
}

/** The theme pieces read today. A series swaps this in Phase 6b. */
export const theme = defaultTheme;
export type Theme = BrandTheme;
