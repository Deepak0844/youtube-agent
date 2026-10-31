import React from "react";
import { AbsoluteFill, Img, interpolate, useCurrentFrame } from "remotion";
import { fitFont, safeSize } from "./layout";
import { theme } from "./theme";

export type BrowserProps = {
  title: string;
  /** Drawn as a label only; never fetched. */
  url: string;
  /** Image blocks carry an already-staged src (the pipeline resolves the asset id). */
  blocks: (
    { type: "heading" | "text"; text: string } | { type: "image"; src: string }
  )[];
  framesPerBlock: number;
};

export const Browser: React.FC<BrowserProps> = ({
  title,
  url,
  blocks,
  framesPerBlock,
}) => {
  const frame = useCurrentFrame();
  // Room for the page content: card height minus the address bar, minus content padding.
  const safe = safeSize(theme);
  const avail = safe.h - 190 - 2 * 36;
  const images = blocks.filter((b) => b.type === "image").length;
  const imgH = Math.min(420, Math.floor((avail * 0.5) / Math.max(1, images)));
  const size = fitFont(
    blocks.flatMap((b) => (b.type === "image" ? [] : [b.text])),
    {
      width: safe.w - 72,
      height: avail - images * (imgH + 28),
      min: theme.type.min,
      max: theme.type.big,
      charW: 0.55,
      lineH: 1.45,
      perItem: 28,
    },
  );
  return (
    <AbsoluteFill
      style={{
        background: theme.palette.bg,
        padding: `${theme.safe.top}px ${theme.safe.side}px ${theme.safe.bottom}px`,
        fontFamily: theme.fonts.ui,
        color: theme.palette.text,
        justifyContent: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          borderRadius: 32,
          overflow: "hidden",
          background: theme.palette.surface,
          border: `2px solid ${theme.palette.bubbleThem}`,
        }}
      >
        <div
          style={{ padding: "20px 28px", background: theme.palette.bubbleThem }}
        >
          <div
            style={{
              fontSize: 30,
              color: theme.palette.muted,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </div>
          <div
            style={{
              marginTop: 14,
              padding: "12px 24px",
              borderRadius: 999,
              background: theme.palette.bg,
              fontFamily: theme.fonts.mono,
              fontSize: 30,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            <span style={{ color: theme.palette.accent }}>https:// </span>
            {url}
          </div>
        </div>
        <div
          style={{
            flex: 1,
            padding: 36,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          {blocks.map((b, i) => {
            const opacity = interpolate(
              frame - i * framesPerBlock,
              [0, 10],
              [0, 1],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
            );
            if (b.type === "image")
              return (
                <Img
                  key={i}
                  src={b.src}
                  style={{
                    width: "100%",
                    height: imgH,
                    objectFit: "cover",
                    borderRadius: 20,
                    marginBottom: 28,
                    opacity,
                  }}
                />
              );
            return (
              <div
                key={i}
                style={{
                  marginBottom: 28,
                  opacity,
                  fontSize:
                    b.type === "heading" ? Math.round(size * 1.2) : size,
                  fontWeight: b.type === "heading" ? 700 : 400,
                  color:
                    b.type === "heading"
                      ? theme.palette.text
                      : theme.palette.muted,
                }}
              >
                {b.text}
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
