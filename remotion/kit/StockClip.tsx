import React from "react";
import { AbsoluteFill, Img, OffthreadVideo } from "remotion";
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

export const StockClip: React.FC<StockClipProps> = ({ src, media, dim, caption, captionZone = "lower_safe" }) => (
  <AbsoluteFill style={{ background: theme.palette.bg }}>
    {media === "image" ? <Img src={src} style={fill} /> : <OffthreadVideo src={src} muted style={fill} />}
    {dim > 0 ? <AbsoluteFill style={{ background: `rgba(0,0,0,${dim})` }} /> : null}
    {caption ? (
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
