import React from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from "remotion";
import { kenBurns, type KenBurns } from "./helpers";
import { ScriptText } from "./ScriptText";
import { theme } from "./theme";

export type StoryProps = {
  /** Image URL or staticFile() path. */
  image: string;
  motion: KenBurns;
  caption?: string;
  captionZone?: "upper_safe" | "lower_safe";
};

export const Story: React.FC<StoryProps> = ({ image, motion, caption, captionZone = "lower_safe" }) => {
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
      {caption ? (
        <div
          style={{
            position: "absolute",
            left: theme.safe.side,
            right: theme.safe.side,
            ...(captionZone === "upper_safe" ? { top: theme.safe.top } : { bottom: theme.safe.bottom }),
            textAlign: "center",
            fontSize: theme.type.caption,
            fontWeight: 700,
            color: theme.palette.text,
            textShadow: "0 2px 12px rgba(0,0,0,.7)",
          }}
        >
          <ScriptText text={caption} />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
