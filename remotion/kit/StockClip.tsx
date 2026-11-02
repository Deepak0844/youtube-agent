import React from "react";
import { AbsoluteFill, OffthreadVideo } from "remotion";
import { lookBg } from "./look";
import { PhotoFit, useSceneCaptions } from "./LookParts";
import { theme } from "./theme";

export type StockClipProps = {
  /** URL or staticFile() path the renderer resolved from the asset id. */
  src: string;
  media: "image" | "video";
  dim: number;
  caption?: string;
  captionZone?: "upper_safe" | "lower_safe";
};

const fill: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };

export const StockClip: React.FC<StockClipProps> = ({ src, media, dim, caption, captionZone = "lower_safe" }) => {
  const showCaption = useSceneCaptions();
  const { top, bottom, side } = theme.safe;
  return (
    <AbsoluteFill style={{ background: lookBg }}>
      {media === "image" ? (
        <PhotoFit src={src} box={{ x: side, y: top, w: theme.width - 2 * side, h: theme.height - top - bottom }} />
      ) : (
        <>
          {/* Blur-fit like PhotoFit: a blurred cover copy fills the frame, the clip itself is shown whole (landscape gets soft bars). */}
          <OffthreadVideo src={src} muted loop style={{ ...fill, filter: "blur(40px) brightness(0.45)", transform: "scale(1.2)" }} />
          <OffthreadVideo src={src} muted loop style={{ ...fill, objectFit: "contain" }} />
        </>
      )}
      {dim > 0 ? <AbsoluteFill style={{ background: `rgba(0,0,0,${dim})` }} /> : null}
      {caption && showCaption ? (
        <div
          style={{
            position: "absolute",
            left: theme.safe.side,
            right: theme.safe.side,
            ...(captionZone === "upper_safe" ? { top: theme.safe.top } : { bottom: theme.safe.bottom }),
            textAlign: "center",
            fontFamily: theme.fonts.ui,
            fontWeight: 700,
            fontSize: 64,
            color: theme.palette.text,
            textShadow: "0 4px 24px rgba(0,0,0,0.7)",
          }}
        >
          {caption}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
