import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { StylePreset } from "./presets";

// Paper grain: fixed noise, same on every frame (so it never flickers). Inline SVG turbulence, no file.
const GRAIN = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='4'/></filter><rect width='240' height='240' filter='url(%23n)' opacity='0.9'/></svg>")`;
const DOTS = [[16, 30, 0], [34, 52, 2], [58, 40, 4], [74, 58, 1], [46, 22, 3], [86, 34, 5]] as const;

/** Frame-wide extras a style asks for: paper grain (paper cutout), vignette and a few slowly drifting glow dots (storybook calm). */
export const StyleFx: React.FC<{ fx: NonNullable<StylePreset["fx"]>; accent: string }> = ({ fx, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {fx.glowDots
        ? DOTS.map(([x, y, ph], i) => (
            <i key={i} style={{ position: "absolute", left: `${x}%`, top: `${y + Math.sin(t * 0.6 + ph) * 2}%`, width: 10, height: 10, borderRadius: "50%", background: accent, opacity: 0.55 + 0.35 * Math.sin(t * 0.9 + ph), boxShadow: `0 0 18px 7px ${accent}99` }} />
          ))
        : null}
      {fx.vignette ? <AbsoluteFill style={{ background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,${fx.vignette}) 100%)` }} /> : null}
      {fx.grain ? <AbsoluteFill style={{ backgroundImage: GRAIN, opacity: 0.09, mixBlendMode: "overlay" }} /> : null}
    </AbsoluteFill>
  );
};
