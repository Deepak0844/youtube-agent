import React from "react";
import { ToonContext, type ToonInput } from "./toon/context";
import { isCartoonStyle } from "./toon/styles";
import { TsxCaptions } from "./TsxCaptions";
import { StyleContext } from "./tsxlib/style";
import { setActiveStyle } from "./tsxlib/styledata";
import type { CaptionWord } from "./timeline";

// inputProps (written by the host): { props: <the scene's props>, frames: meta.durationInFrames from the checked file, captions, style, orientation, toon }.
// The length comes from the host, not from the scene module, so the scene cannot change its own duration at run time. The style id
// comes from the host too (the video's style; unknown or missing = ai_studio): it picks the yt-kit colours, fonts, motion and captions.
// A cartoon style (cartoon_comic ...) with `toon` (beats, cast) hands those to the scene through ToonContext; its captions are drawn
// by the cartoon film itself (cartoon-shorts' own caption look), so TsxCaptions stays out of the way.
export type TsxFrameInput = { props?: Record<string, unknown>; frames?: number; captions?: CaptionWord[]; style?: string; orientation?: "portrait" | "landscape"; toon?: ToonInput };

export const TsxFrame: React.FC<TsxFrameInput & { Scene: React.ComponentType<Record<string, unknown>> }> = ({ props, captions, style, toon, Scene }) => {
  const st = setActiveStyle(style); // before any child renders: PALETTE / FONTS / MOTION / PACE read this style for the whole render
  const cs = isCartoonStyle(style) ? style : undefined;
  const cartoon = cs !== undefined && toon !== undefined;
  const scene = <Scene {...(props ?? {})} />;
  return (
    <StyleContext.Provider value={st}>
      {cartoon ? <ToonContext.Provider value={{ ...toon, style: cs }}>{scene}</ToonContext.Provider> : scene}
      {!cartoon && captions && captions.length > 0 ? <TsxCaptions words={captions} /> : null}
    </StyleContext.Provider>
  );
};
