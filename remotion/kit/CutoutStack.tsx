import { lookBg } from "./look";
import React from "react";
import { AbsoluteFill, Img, useCurrentFrame } from "remotion";
import { cutoutRects, enterState, type CollageEnter } from "./helpers";
import { useSceneCaptions } from "./LookParts";
import { theme } from "./theme";

export type CutoutLayer = {
  /** Resolved picture URL or staticFile() path (the job resolves the asset id). A PNG with a see-through background. */
  src: string;
  enter: CollageEnter;
  /** Frame this layer starts to enter (computed by the caller from delayMs). */
  startFrame: number;
};
export type CutoutStackProps = { layers: CutoutLayer[]; backing: boolean; caption?: string; captionZone?: "upper_safe" | "lower_safe" };

/** Cut-out pictures laid over the look's background, each with a soft shadow, entering one after another. A soft panel behind them keeps them readable. */
export const CutoutStack: React.FC<CutoutStackProps> = ({ layers, backing, caption, captionZone = "lower_safe" }) => {
  const frame = useCurrentFrame();
  const showCaption = useSceneCaptions();
  const { width, height } = theme;
  const { top, bottom, side } = theme.safe;
  const box = { x: side, y: top, w: width - side * 2, h: height - top - bottom };
  const rects = cutoutRects(layers.length, box);
  return (
    <AbsoluteFill style={{ background: lookBg }}>
      {backing ? <div style={{ position: "absolute", left: box.x - 24, top: box.y - 24, width: box.w + 48, height: box.h + 48, borderRadius: 40, background: "rgba(11,13,18,0.38)" }} /> : null}
      {layers.map((l, i) => {
        const r = rects[i]!;
        const s = enterState(l.enter, frame, l.startFrame);
        return (
          <div key={i} style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, opacity: s.opacity, transform: `translate(${s.x}px, ${s.y}px) scale(${s.scale})` }}>
            <Img src={l.src} style={{ width: "100%", height: "100%", objectFit: "contain", filter: "drop-shadow(0 14px 22px rgba(0,0,0,0.5))" }} />
          </div>
        );
      })}
      {caption && showCaption ? (
        <div
          style={{
            position: "absolute",
            left: theme.safe.side,
            right: theme.safe.side,
            ...(captionZone === "upper_safe" ? { top: theme.safe.top } : { bottom: theme.safe.bottom }),
            textAlign: "center",
            fontFamily: theme.fonts.ui,
            fontWeight: 700,
            fontSize: 64,
            color: theme.palette.text,
            textShadow: "0 4px 24px rgba(0,0,0,0.7)",
          }}
        >
          {caption}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
