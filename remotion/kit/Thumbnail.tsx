import React from "react";
import { AbsoluteFill, staticFile } from "remotion";
import { Headline, LookProvider, PhotoFit } from "./LookParts";
import { lookBackground, pickLook } from "./look";
import { DARK_INK } from "./ink";
import { thumbnailBoxes, thumbnailFontSize, thumbnailTitle } from "./thumbnailLayout";

export type ThumbnailProps = { title?: string; seed?: string; /** a staged picture (public-dir path) shown on the right */ src?: string };

/** The long-video thumbnail card: the video's look, the title in big type with its key word in the accent colour, one optional picture. */
export const Thumbnail: React.FC<ThumbnailProps> = ({ title, seed = "thumbnail", src }) => {
  const look = pickLook(seed);
  const text = thumbnailTitle(title);
  const boxes = thumbnailBoxes(Boolean(src));
  return (
    <LookProvider value={{ look, sceneCaptions: true, ink: DARK_INK }}>
      <AbsoluteFill style={{ background: lookBackground(look), overflow: "hidden" }}>
        <div style={{ position: "absolute", left: boxes.text.x, top: boxes.text.y, width: boxes.text.w, height: boxes.text.h, display: "flex", alignItems: "center", textShadow: "0 6px 24px rgba(0,0,0,0.6)" }}>
          <Headline ink={DARK_INK} text={text} size={thumbnailFontSize(text, Boolean(src))} style={{ transform: "none", lineHeight: 1.08 }} />
        </div>
        {/* The picture gets its own clipped panel: PhotoFit paints a blurred copy of the picture over its whole parent, which would cover the title. */}
        {src && boxes.picture ? (
          <div style={{ position: "absolute", left: boxes.picture.x, top: boxes.picture.y, width: boxes.picture.w, height: boxes.picture.h, overflow: "hidden", borderRadius: 28 }}>
            <PhotoFit src={staticFile(src)} box={{ x: 0, y: 0, w: boxes.picture.w, h: boxes.picture.h }} radius={28} border={8} />
          </div>
        ) : null}
      </AbsoluteFill>
    </LookProvider>
  );
};
