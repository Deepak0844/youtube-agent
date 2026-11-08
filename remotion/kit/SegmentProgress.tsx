import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { blockSizes, progressSegments, type Chapter, type Layout } from "./frameLayout";
import { theme } from "./theme";

/** Thin bar along the bottom, one segment per chapter (one segment if there are none), filling as the video plays. */
export const SegmentProgress: React.FC<{ layout: Layout; chapters: readonly Chapter[] }> = ({ layout, chapters }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = blockSizes(layout);
  const segs = progressSegments(chapters, (durationInFrames / fps) * 1000, (frame / fps) * 1000);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", paddingBottom: s.barBottom, paddingLeft: s.barSide, paddingRight: s.barSide }}>
      <div style={{ display: "flex", gap: s.barGap, height: s.barHeight }}>
        {segs.map((g, i) => (
          <div key={i} style={{ flex: g.weight, background: theme.palette.gridLine, borderRadius: s.barHeight, overflow: "hidden" }}>
            <div style={{ width: `${g.fill * 100}%`, height: "100%", background: theme.palette.accent }} />
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
