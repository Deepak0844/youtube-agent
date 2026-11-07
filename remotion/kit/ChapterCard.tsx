import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { blockSizes, type Layout } from "./frameLayout";
import { theme } from "./theme";

/** Full-frame chapter title card: "Chapter n" kicker, big title, accent rule. Fades in and out over its own Sequence. */
export const ChapterCard: React.FC<{ layout: Layout; index: number; title: string }> = ({ layout, index, title }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const s = blockSizes(layout);
  const land = layout === "landscape";
  const fade = Math.min(10, Math.floor(durationInFrames / 2));
  const opacity = interpolate(frame, [0, fade, durationInFrames - fade, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity, background: theme.palette.bg, justifyContent: "center", alignItems: land ? "flex-start" : "center", padding: `0 ${s.thirdLeft}px`, fontFamily: theme.fonts.ui }}>
      <div style={{ color: theme.palette.accent, fontSize: s.cardKicker, fontWeight: 800, letterSpacing: 4, textTransform: "uppercase" }}>{`Chapter ${index + 1}`}</div>
      <div style={{ color: theme.palette.text, fontSize: s.cardTitle, fontWeight: 900, lineHeight: 1.1, marginTop: 20, textAlign: land ? "left" : "center" }}>{title}</div>
      <div style={{ width: 160, height: 8, borderRadius: 4, background: theme.palette.accent, marginTop: 36 }} />
    </AbsoluteFill>
  );
};
