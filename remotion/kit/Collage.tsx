import { lookBg } from "./look";
import React from "react";
import { AbsoluteFill, OffthreadVideo, useCurrentFrame } from "remotion";
import { collageRects, enterState, type CollageEnter, type CollageLayout } from "./helpers";
import { PhotoFit, useLook, useSceneCaptions } from "./LookParts";
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
  const { width, height } = theme; // the 1080x1920 stage, even when a landscape frame hosts it
  const showCaption = useSceneCaptions();
  const look = useLook();
  const { top, bottom, side } = theme.safe;
  const rects = collageRects(layout, tiles.length, { x: side, y: top, w: width - side * 2, h: height - top - bottom });
  return (
    <AbsoluteFill style={{ background: lookBg }}>
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
              boxShadow: "0 14px 40px rgba(0,0,0,0.45)",
              border: `4px solid ${look.accent}`,
              boxSizing: "border-box",
              opacity: s.opacity,
              transform: `translate(${s.x}px, ${s.y}px) scale(${s.scale})`,
            }}
          >
            {t.media === "clip" ? (
              <OffthreadVideo src={t.src} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <PhotoFit src={t.src} box={{ x: 0, y: 0, w: r.w, h: r.h }} radius={0} border={0} />
            )}
            {t.caption && showCaption ? (
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
