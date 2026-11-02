// Per-video look, as plain data (no React, so it is unit-tested). Palette is picked from the video seed at render time.
import type { CaptionWord } from "./timeline";
import { currentWord } from "./timeline";

export type Look = { name: string; from: string; to: string; accent: string; accent2: string };

/** Curated pairs: white text reads on `from`/`to`, and `accent` reads on `from` (checked in tests). */
export const LOOKS: readonly Look[] = [
  { name: "blue-yellow", from: "#0a1640", to: "#1e40af", accent: "#facc15", accent2: "#7dd3fc" },
  { name: "purple-orange", from: "#2a0b4d", to: "#6d28d9", accent: "#fb923c", accent2: "#c4b5fd" },
  { name: "teal-coral", from: "#042f35", to: "#0f766e", accent: "#ff8a7a", accent2: "#99f6e4" },
  { name: "crimson-cream", from: "#3b0a1a", to: "#9f1239", accent: "#fde68a", accent2: "#fda4af" },
  { name: "forest-lime", from: "#052e1a", to: "#166534", accent: "#bef264", accent2: "#86efac" },
];

export const hashString = (s: string): number => {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
};

export const pickLook = (seed: string): Look => LOOKS[hashString(seed) % LOOKS.length]!;

/** Soft gradient plus two big faint circles, as one CSS background value. */
export const lookBackground = (l: Look): string =>
  `radial-gradient(circle at 88% 12%, ${l.accent}22 0, ${l.accent}00 34%), radial-gradient(circle at 8% 72%, ${l.accent2}22 0, ${l.accent2}00 40%), linear-gradient(165deg, ${l.from} 0%, ${l.to} 100%)`;

/** Scene roots paint this; KitVideo sets --look-bg. Outside KitVideo (previews) it falls back to the flat colour. */
export const lookBg = "var(--look-bg, #0b0d12)";

/** Index of the word to highlight in a headline: the longest one (the last, on a tie). -1 for empty text. */
export function keyWordIndex(words: readonly string[]): number {
  let best = -1;
  words.forEach((w, i) => {
    if (best < 0 || w.length >= words[best]!.length) best = i;
  });
  return best;
}

/** True when a scene may draw its own caption: no word captions, or none visible at tS. One caption layer at a time. */
export const sceneCaptionAllowed = (words: readonly CaptionWord[] | undefined, tS: number): boolean => !words?.length || currentWord(words, tS) < 0;

/** Largest zoom a photo gets (6%), and a pan cap, so a picture only drifts gently. */
export function gentleMotion<T extends { zoomFrom: number; zoomTo: number; panX: number; panY: number }>(k: T): T {
  const z = (v: number) => Math.min(1.06, Math.max(1, v));
  const p = (v: number) => Math.min(0.015, Math.max(-0.015, v));
  return { ...k, zoomFrom: z(k.zoomFrom), zoomTo: z(k.zoomTo), panX: p(k.panX), panY: p(k.panY) };
}

/** Scenes longer than this keep moving (slow zoom on photos, node pulse on diagrams) so something changes every few seconds. */
export const LONG_SCENE_FRAMES = 180;

/** A photo that would sit still on a long scene gets a slow 5% zoom-in instead. */
export function keepMoving<T extends { zoomFrom: number; zoomTo: number }>(k: T, frames: number): T {
  return frames > LONG_SCENE_FRAMES && Math.abs(k.zoomTo - k.zoomFrom) < 0.03 ? { ...k, zoomTo: k.zoomFrom + 0.05 } : k;
}

/** Largest rect with the picture's aspect that fits wholly inside the box, centred. Never crops. */
export function fitContain(nat: { w: number; h: number }, box: { x: number; y: number; w: number; h: number }) {
  const s = Math.min(box.w / nat.w, box.h / nat.h);
  const w = nat.w * s;
  const h = nat.h * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** Quick pop-in: 0.82 up to 1 over `frames`, with a small overshoot. */
export function popScale(frame: number, start = 0, frames = 9): number {
  const t = Math.min(1, Math.max(0, (frame - start) / frames));
  const c = 1.70158;
  const e = 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  return 0.82 + 0.18 * e;
}

/** Hook title card: shown over the first scene for HOOK_FRAMES, fully opaque, then fading out over HOOK_FADE_FRAMES. */
export const HOOK_FRAMES = 45;
export const HOOK_FADE_FRAMES = 12;
export const HOOK_BADGE = "Explained";

/** Card opacity at a frame of the card's own clock: 1 until the fade starts, 0 at the end (and after). */
export function hookOpacity(frame: number, total = HOOK_FRAMES, fade = HOOK_FADE_FRAMES): number {
  const start = total - fade;
  if (frame <= start) return 1;
  return Math.max(0, Math.min(1, 1 - (frame - start) / fade));
}

const LEADING_FILLER = new Set(["how", "why", "what", "when", "the", "a", "an", "is", "are", "does", "do", "did", "can", "this", "that", "of"]);

/** 3-5 word card title from a video title or topic: no AI. Drops leading filler words only when the text is too long. */
export function shortTitle(text: string | undefined, maxWords = 5): string {
  let words = (text ?? "").replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
  while (words.length > maxWords && LEADING_FILLER.has(words[0]!.toLowerCase())) words = words.slice(1);
  const out = words.slice(0, maxWords).map((w) => w.slice(0, 16)).join(" ");
  return out || "Watch this";
}

/** First picture the doc links (keys "asset" / "image", in scene order) that `usable` accepts; undefined when none. */
export function firstPictureId(v: unknown, usable: (id: string) => boolean): string | undefined {
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = firstPictureId(x, usable);
      if (r) return r;
    }
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if ((k === "asset" || k === "image") && typeof x === "string") {
        if (usable(x)) return x;
      } else {
        const r = firstPictureId(x, usable);
        if (r) return r;
      }
    }
  }
  return undefined;
}

export const contrast = (a: string, b: string): number => {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
};
