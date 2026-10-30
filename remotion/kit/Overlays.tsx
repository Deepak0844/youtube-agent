import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "./theme";

// Overlays, not scene kinds: mount on top of a whole composition.
export const ProgressBar: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 6, background: theme.palette.surface }}>
      <div style={{ width: `${(frame / Math.max(1, durationInFrames - 1)) * 100}%`, height: "100%", background: theme.palette.accent }} />
    </div>
  );
};

// Dev only: tints the unsafe margins. Never mount in a final render.
export const SafeAreaGuides: React.FC = () => {
  const tint = "rgba(255,0,0,0.14)";
  const { top, bottom, side } = theme.safe;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: top, background: tint }} />
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: bottom, background: tint }} />
      <div style={{ position: "absolute", top, bottom, left: 0, width: side, background: tint }} />
      <div style={{ position: "absolute", top, bottom, right: 0, width: side, background: tint }} />
    </AbsoluteFill>
  );
};
