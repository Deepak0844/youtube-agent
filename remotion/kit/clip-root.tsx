import React from "react";
import { AbsoluteFill, Composition, OffthreadVideo, staticFile } from "remotion";
import { TsxCaptions } from "./TsxCaptions";
import { StyleContext } from "./tsxlib/style";
import { setActiveStyle } from "./tsxlib/styledata";
import type { CaptionWord } from "./timeline";

// Clip Factory CF2b (render-entry.mjs --clip): a finished 1080x1920 clip (public/clip.mp4, already cut and reframed by the host)
// with the app's captions drawn over it. Fixed code from the read-only kit: no model-written code is involved. The length,
// the word times and the style id come from the host's meta.json (validated by render-entry.mjs); the clip's own sound is kept.
type Input = { frames?: number; captions?: CaptionWord[]; style?: string };

const Clip: React.FC<Input> = ({ captions, style }) => {
  const st = setActiveStyle(style);
  return (
    <StyleContext.Provider value={st}>
      <AbsoluteFill style={{ background: "#000" }}>
        <OffthreadVideo src={staticFile("clip.mp4")} />
      </AbsoluteFill>
      {captions && captions.length > 0 ? <TsxCaptions words={captions} /> : null}
    </StyleContext.Provider>
  );
};

export const ClipRoot: React.FC = () => (
  <Composition
    id="clip-video"
    component={Clip}
    durationInFrames={1}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ frames: 1 } as Input}
    calculateMetadata={({ props }) => ({ durationInFrames: Number(props.frames) })}
  />
);
