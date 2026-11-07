import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { ChapterCard } from "./ChapterCard";
import { chapterCardFrames, stageGeometry, type Chapter } from "./frameLayout";
import { LowerThird } from "./LowerThird";
import { SegmentProgress } from "./SegmentProgress";
import { theme } from "./theme";
import { msToFrame } from "./timeline";

export type LowerThirdSpec = { text: string; sub?: string; startMs: number; durationMs: number };
export type LandscapeExtras = { chapters?: Chapter[]; lowerThirds?: LowerThirdSpec[] };

/**
 * 1920x1080 long-form frame. Scenes still lay out on the 1080x1920 stage (they are not re-laid out per layout yet), scaled to full height and
 * centred on a dark backdrop; chapter cards, lower thirds and the progress bar are landscape-native and drawn on top.
 */
export const LandscapeFrame: React.FC<LandscapeExtras & { fps: number; totalMs: number; children: React.ReactNode }> = ({ chapters = [], lowerThirds = [], fps, totalMs, children }) => {
  const g = stageGeometry();
  return (
    <AbsoluteFill style={{ background: theme.palette.bg, overflow: "hidden" }}>
      <div style={{ position: "absolute", width: theme.width, height: theme.height, left: g.left, top: g.top, transform: `scale(${g.scale})`, transformOrigin: "center center", overflow: "hidden" }}>{children}</div>
      {lowerThirds.map((t, i) => (
        <Sequence key={`lt${i}`} from={msToFrame(t.startMs, fps)} durationInFrames={Math.max(1, msToFrame(t.durationMs, fps))}>
          <LowerThird layout="landscape" text={t.text} sub={t.sub} />
        </Sequence>
      ))}
      {chapters.map((c, i) => (
        <Sequence key={`ch${i}`} from={msToFrame(c.startMs, fps)} durationInFrames={chapterCardFrames(chapters, i, totalMs, fps)}>
          <ChapterCard layout="landscape" index={i} title={c.title} />
        </Sequence>
      ))}
      <SegmentProgress layout="landscape" chapters={chapters} />
    </AbsoluteFill>
  );
};
