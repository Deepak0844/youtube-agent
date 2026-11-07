import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { blockSizes, lowerThirdOpacity, type Layout } from "./frameLayout";
import { theme } from "./theme";

/** Name / topic tag at the bottom left, above the caption band. Put it in a Sequence; it fades over that Sequence's length. */
export const LowerThird: React.FC<{ layout: Layout; text: string; sub?: string }> = ({ layout, text, sub }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const s = blockSizes(layout);
  return (
    <AbsoluteFill style={{ opacity: lowerThirdOpacity(frame, durationInFrames), justifyContent: "flex-end", paddingBottom: s.thirdBottom, paddingLeft: s.thirdLeft, fontFamily: theme.fonts.ui }}>
      <div style={{ alignSelf: "flex-start", borderLeft: `8px solid ${theme.palette.accent}`, background: "rgba(0,0,0,0.65)", padding: "14px 28px", borderRadius: 8 }}>
        <div style={{ color: theme.palette.text, fontSize: s.thirdFont, fontWeight: 800 }}>{text}</div>
        {sub ? <div style={{ color: theme.palette.muted, fontSize: s.thirdSub, fontWeight: 600, marginTop: 4 }}>{sub}</div> : null}
      </div>
    </AbsoluteFill>
  );
};
