import React from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from "remotion";
import { kenBurns, type KenBurns } from "./helpers";
import { theme } from "./theme";

export type StoryProps = {
  /** Image URL or staticFile() path. */
  image: string;
  motion: KenBurns;
};

export const Story: React.FC<StoryProps> = ({ image, motion }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const { scale, x, y } = kenBurns(frame, durationInFrames, motion);
  return (
    <AbsoluteFill style={{ background: theme.palette.bg, overflow: "hidden" }}>
      <Img
        src={image}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `translate(${x * width}px, ${y * height}px) scale(${scale})`,
        }}
      />
    </AbsoluteFill>
  );
};
