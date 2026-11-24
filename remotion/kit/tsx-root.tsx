import React from "react";
import { Composition } from "remotion";
// @ts-expect-error resolved only inside the render container (webpack alias to /in/video.tsx, see render-entry.mjs)
import Scene from "tsx-scene";
import { TsxFrame, type TsxFrameInput } from "./tsx-frame";

type Input = TsxFrameInput;

const Wrapped: React.FC<Input> = (p) => <TsxFrame {...p} Scene={Scene} />;

export const TsxRoot: React.FC = () => (
  <Composition
    id="tsx-video"
    component={Wrapped}
    durationInFrames={1}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ props: {}, frames: 1 } as Input}
    calculateMetadata={({ props }) => (props.orientation === "landscape" ? { durationInFrames: Number(props.frames), width: 1920, height: 1080 } : { durationInFrames: Number(props.frames) })}
  />
);
