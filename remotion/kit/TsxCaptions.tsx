import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { captionAt } from "./tsx-caption-page";
import { useStyle } from "./tsxlib/style";
import type { TsxStyle } from "./tsxlib/styledata";
import type { CaptionWord } from "./timeline";

// Drawn by tsx-root around the model's scene (the scene draws no captions). Bottom safe zone: below y = 1497.
// The look follows the video's style (presets.ts `captions`): pill (a block behind the words), paged (big outlined words),
// tags (one tilted paper tag per word) or kinetic (big staggered words). Always inside the caption band; never in the scene.
const FALLBACK_PILL = "rgba(10,12,28,0.72)";

function look(st: TsxStyle): { box: React.CSSProperties; word: React.CSSProperties; active: string; per: number; tag: boolean } {
  const c = st.captions;
  const active = c.activeColor === "look" ? st.colors.accent : c.activeColor;
  const font = c.font ? `"${c.font}", ${st.fonts.body.split(", ").pop()}` : st.fonts.body;
  const base: React.CSSProperties = { fontFamily: font, fontWeight: 800, lineHeight: 1.1, textAlign: "center" };
  const size = Math.min(c.fontSize, c.layout === "kinetic" ? 120 : 96);
  if (c.layout === "paged") return { box: {}, word: { ...base, fontSize: size, color: "#ffffff", WebkitTextStroke: `${c.outlinePx}px #000`, paintOrder: "stroke fill" }, active, per: c.wordsPerPage, tag: false };
  if (c.layout === "tags") return { box: {}, word: { ...base, fontSize: size, color: c.textColor ?? "#f3e6d3", background: c.activeColor, borderRadius: 10, padding: "2px 22px", transform: "rotate(-3deg)", boxShadow: "6px 6px 0 rgba(0,0,0,0.45)" }, active, per: 1, tag: true };
  if (c.layout === "kinetic") return { box: {}, word: { ...base, fontSize: size, textTransform: "uppercase", color: c.textColor ?? st.colors.text, WebkitTextStroke: "4px #000", paintOrder: "stroke fill" }, active, per: c.wordsPerPage, tag: false };
  // pill: a block behind the words (dark by default, the style's own colour when it has one, none when transparent)
  const bg = c.pillBg === "transparent" ? undefined : c.pillBg ?? FALLBACK_PILL;
  const text = c.textColor ?? "#ffffff";
  return {
    box: bg ? { background: bg, borderRadius: 28, padding: "10px 30px" } : {},
    word: { ...base, fontSize: Math.min(size, 76), color: text, ...(bg ? {} : { textShadow: c.glow ? `0 0 24px ${c.glow}, 0 2px 8px rgba(0,0,0,0.6)` : "0 3px 14px rgba(0,0,0,0.7)" }) },
    active,
    per: c.wordsPerPage,
    tag: false,
  };
}

export const TsxCaptions: React.FC<{ words: CaptionWord[] }> = ({ words }) => {
  const { fps } = useVideoConfig();
  const st = useStyle();
  const lk = look(st);
  const page = captionAt(words, useCurrentFrame() / fps, lk.per);
  if (!page) return null;
  return (
    <div style={{ position: "absolute", left: 60, right: 60, bottom: 150, display: "flex", justifyContent: st.captions.align === "left" ? "flex-start" : "center", pointerEvents: "none" }}>
      <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: lk.tag ? "0" : "0 22px", ...lk.box }}>
        {page.words.map((w, i) => (
          <span key={i} style={{ ...lk.word, ...(i === page.active ? { color: lk.tag ? "#ffffff" : lk.active } : {}) }}>{w}</span>
        ))}
      </div>
    </div>
  );
};
