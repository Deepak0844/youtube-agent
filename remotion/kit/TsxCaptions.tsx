import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { captionAt } from "./tsx-caption-page";
import type { CaptionWord } from "./timeline";

// Drawn by tsx-root around the model's scene (the scene draws no captions). Bottom safe zone: below y = 1497.
export const TsxCaptions: React.FC<{ words: CaptionWord[] }> = ({ words }) => {
  const { fps } = useVideoConfig();
  const page = captionAt(words, useCurrentFrame() / fps);
  if (!page) return null;
  return (
    <div style={{ position: "absolute", left: 60, right: 60, bottom: 150, display: "flex", justifyContent: "center", flexWrap: "wrap", gap: "0 22px", fontFamily: "Inter, sans-serif", fontWeight: 800, fontSize: 84, lineHeight: 1.1, textAlign: "center", pointerEvents: "none" }}>
      {page.words.map((w, i) => (
        <span key={i} style={{ color: i === page.active ? "#ffe45e" : "#ffffff", WebkitTextStroke: "6px #000", paintOrder: "stroke fill" }}>{w}</span>
      ))}
    </div>
  );
};
