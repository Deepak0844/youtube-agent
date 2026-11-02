import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { kenBurns, type KenBurns } from "./helpers";
import { gentleMotion, lookBg } from "./look";
import { PhotoFit, useSceneCaptions } from "./LookParts";
import { ScriptText } from "./ScriptText";
import { theme } from "./theme";

export type StoryProps = {
  /** Image URL or staticFile() path. */
  image: string;
  motion: KenBurns;
  caption?: string;
  captionZone?: "upper_safe" | "lower_safe";
};

// The whole picture sits sharp inside the safe area over a blurred copy of itself; zoom is capped at 6%.
export const Story: React.FC<StoryProps> = ({ image, motion, caption, captionZone = "lower_safe" }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const showCaption = useSceneCaptions();
  const { scale, x, y } = kenBurns(frame, durationInFrames, gentleMotion(motion));
  const { top, bottom, side } = theme.safe;
  return (
    <AbsoluteFill style={{ background: lookBg, overflow: "hidden" }}>
      <PhotoFit src={image} box={{ x: side, y: top, w: width - 2 * side, h: height - top - bottom }} zoom={scale} tx={x * width} ty={y * height} />
      {caption && showCaption ? (
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
