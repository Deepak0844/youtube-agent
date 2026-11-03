// yt-kit layout zones: a fixed title / objects / captions split of the 1080x1920 frame, so a scene cannot put the headline
// on a prop, a label on an object, or anything under the studio's captions. All numbers are clamped, colours go through safeColor().
import React from "react";
import { AbsoluteFill } from "remotion";
import { Chip, KitDefs } from "./layout";
import { useStyle } from "./style";
import { num, safeColor, txt, W, H } from "./util";

/** Vertical bands (pixels on the 1080x1920 canvas). Captions are drawn by the studio at about y 1585-1770. */
export const ZONES = {
  title: { y0: 70, y1: 330 },
  objects: { y0: 360, y1: 1380 },
  captions: { y0: 1420, y1: 1900 },
} as const;

const SIDE = 60; // keep this far from the left and right edges

/** Greedy word wrap with a per-character width estimate (glyphW x font size) for the style heading font. */
function wrap(text: string, size: number, glyphW = 0.64): string[] {
  const perLine = Math.max(4, Math.floor((W - 2 * SIDE) / (size * glyphW + 1)));
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(" ").filter(Boolean)) {
    const next = cur ? cur + " " + w : w;
    if (next.length <= perLine || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Headline sized to fit: the largest type (112 down to 56) whose wrapped lines (at most 3) fit the title zone. Text is cut at 60 characters. */
export const Headline: React.FC<{ text: string; color?: string; accent?: string; opacity?: number }> = ({ text, color, accent, opacity = 1 }) => {
  const st = useStyle();
  const t = txt(text, 60).trim();
  const zoneH = ZONES.title.y1 - ZONES.title.y0;
  let size = 56;
  let lines = wrap(t, size, st.glyphW).slice(0, 3);
  for (let s = 112; s >= 56; s -= 4) {
    const l = wrap(t, s, st.glyphW);
    if (l.length <= 3 && l.length * s * 1.08 <= zoneH) {
      size = s;
      lines = l;
      break;
    }
  }
  const c = color ? safeColor(color, st.colors.text) : st.colors.text;
  const a = accent ? safeColor(accent, c) : st.colors.accent;
  return (
    <div style={{ position: "absolute", left: SIDE, right: SIDE, top: ZONES.title.y0, height: zoneH, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "center", textAlign: "center", opacity: num(opacity, 0, 1, 1) }}>
      {lines.map((l, i) => (
        <div key={i} style={{ fontFamily: st.fonts.display, fontWeight: st.headingWeight, fontSize: size, lineHeight: 1.08, textTransform: st.caps ? "uppercase" : "none", letterSpacing: st.caps ? 1 : 0, color: i === lines.length - 1 ? a : c, textShadow: st.light ? "none" : "0 4px 30px rgba(0,0,0,0.6)" }}>
          {l}
        </div>
      ))}
    </div>
  );
};

/**
 * The page: Headline in the title zone and a persistent svg Canvas whose drawing is clipped to the band between the title and the
 * caption zones, so nothing can cover the headline or the captions. Put props inside (use Place to keep them in the objects zone).
 */
export const Stage: React.FC<{ headline?: string; color?: string; accent?: string; opacity?: number; children?: React.ReactNode }> = ({ headline, color, accent, opacity, children }) => (
  <AbsoluteFill>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
      <defs>
        <clipPath id="yk-zone">
          <rect x={0} y={ZONES.title.y1} width={W} height={ZONES.captions.y0 - ZONES.title.y1} />
        </clipPath>
      </defs>
      <KitDefs />
      <g clipPath="url(#yk-zone)">{children}</g>
    </svg>
    {headline ? <Headline text={headline} color={color} accent={accent} opacity={opacity} /> : null}
  </AbsoluteFill>
);

/**
 * Draws its children (whose own coordinates are centred on 0,0, so write cx={0} cy={0}) in a w x h box centred on x,y at the given
 * scale. The scale shrinks to fit the objects zone and the centre moves so the whole box stays inside it.
 */
export const Place: React.FC<{ x: number; y: number; w: number; h: number; scale?: number; children?: React.ReactNode }> = ({ x, y, w, h, scale = 1, children }) => {
  const bw = num(w, 10, 4000, 400);
  const bh = num(h, 10, 4000, 400);
  const zw = W - 2 * 40;
  const zh = ZONES.objects.y1 - ZONES.objects.y0;
  const s = Math.min(num(scale, 0.1, 4, 1), zw / bw, zh / bh);
  const cx = num(x, 40 + (bw * s) / 2, W - 40 - (bw * s) / 2, 540);
  const cy = num(y, ZONES.objects.y0 + (bh * s) / 2, ZONES.objects.y1 - (bh * s) / 2, 870);
  return <g transform={`translate(${cx} ${cy}) scale(${s})`}>{children}</g>;
};

/**
 * Word pill NEXT to a point (ax, ay) on an object: its near edge sits `offset` px away on the given side, centred across it.
 * Clamped inside the objects zone and the side margins, so it never lands on the title or the captions.
 */
export const Label: React.FC<{ text: string; ax: number; ay: number; side: "top" | "bottom" | "left" | "right"; offset?: number; color?: string; size?: number; at?: number; until?: number }> = ({ text, ax, ay, side, offset = 30, color = "accent", size = 44, at = 0, until }) => {
  const t = txt(text, 28);
  const sz = num(size, 24, 70, 44);
  const w = Math.min(W - 2 * SIDE, t.length * (sz * 0.66 + 1) + 62);
  const h = sz * 1.2 + 22;
  const o = num(offset, 10, 300, 30);
  const px = num(ax, 0, W, 540);
  const py = num(ay, 0, H, 800);
  const cx = side === "left" ? px - o - w / 2 : side === "right" ? px + o + w / 2 : px;
  const cy = side === "top" ? py - o - h / 2 : side === "bottom" ? py + o + h / 2 : py;
  return <Chip text={t} x={num(cx, SIDE + w / 2, W - SIDE - w / 2, 540)} y={num(cy, ZONES.objects.y0 + h / 2, ZONES.objects.y1 - h / 2, 800)} color={color} size={sz} at={at} until={until} />;
};
