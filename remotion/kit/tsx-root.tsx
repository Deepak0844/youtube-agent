import React from "react";
import { Composition } from "remotion";
// @ts-expect-error resolved only inside the render container (webpack alias to /in/video.tsx, see render-entry.mjs)
import Scene from "tsx-scene";
import { TsxCaptions } from "./TsxCaptions";
import type { CaptionWord } from "./timeline";

// inputProps (written by the host): { props: <the scene's props>, frames: meta.durationInFrames from the checked file }.
// The length comes from the host, not from the scene module, so the scene cannot change its own duration at run time.
type Input = { props?: Record<string, unknown>; frames?: number; captions?: CaptionWord[] };

const Wrapped: React.FC<Input> = ({ props, captions }) => (
  <>
    <Scene {...(props ?? {})} />
    {captions && captions.length > 0 ? <TsxCaptions words={captions} /> : null}
  </>
);

export const TsxRoot: React.FC = () => (
  <Composition
    id="tsx-video"
    component={Wrapped}
    durationInFrames={1}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ props: {}, frames: 1 } as Input}
    calculateMetadata={({ props }) => ({ durationInFrames: Number(props.frames) })}
  />
);
