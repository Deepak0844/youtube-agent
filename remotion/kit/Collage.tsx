import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import { collageRects, enterState, type CollageEnter, type CollageLayout } from "./helpers";
import { theme } from "./theme";

export type CollageTile = {
  /** Resolved image/clip URL or staticFile() path (the job resolves the asset id). */
  src: string;
  media: "image" | "clip";
  enter: CollageEnter;
  /** Frame this tile starts to enter (computed by the caller from delayMs). */
  startFrame: number;
  caption?: string;
};
export type CollageProps = { layout: CollageLayout; tiles: CollageTile[] };

export const Collage: React.FC<CollageProps> = ({ layout, tiles }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const { top, bottom, side } = theme.safe;
  const rects = collageRects(layout, tiles.length, { x: side, y: top, w: width - side * 2, h: height - top - bottom });
  return (
    <AbsoluteFill style={{ background: theme.palette.bg }}>
      {tiles.map((t, i) => {
        const r = rects[i];
        const s = enterState(t.enter, frame, t.startFrame);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: r.x,
              top: r.y,
              width: r.w,
              height: r.h,
              overflow: "hidden",
              borderRadius: 24,
              background: theme.palette.surface,
              opacity: s.opacity,
              transform: `translate(${s.x}px, ${s.y}px) scale(${s.scale})`,
            }}
          >
            {t.media === "clip" ? (
              <OffthreadVideo src={t.src} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <Img src={t.src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            )}
            {t.caption ? (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  padding: "16px 20px",
                  background: "rgba(11,13,18,0.7)",
                  color: theme.palette.text,
                  fontFamily: theme.fonts.ui,
                  fontWeight: 600,
                  fontSize: 36,
                }}
              >
                {t.caption}
              </div>
            ) : null}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
