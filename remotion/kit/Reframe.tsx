import React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { reframeGeometry, SRC_H, SRC_W } from "./reframe";

// Render option, not a scene kind: shows a finished 1080x1920 composition inside a 16:9 or 1:1 frame.
// Sharp copy scaled to fit; sides filled by a blurred, dimmed copy. Renders `children` twice.
export const Reframe: React.FC<{ children: React.ReactNode; blur?: number }> = ({ children, blur = 36 }) => {
  const { width, height } = useVideoConfig();
  const g = reframeGeometry(width, height);
  const place = (s: number): React.CSSProperties => ({
    position: "absolute",
    width: SRC_W,
    height: SRC_H,
    left: g.left,
    top: g.top,
    transform: `scale(${s})`,
    transformOrigin: "center center",
  });
  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      <div style={{ ...place(g.fill), filter: `blur(${blur}px) brightness(0.55)` }}>{children}</div>
      <div style={place(g.fit)}>{children}</div>
    </AbsoluteFill>
  );
};
