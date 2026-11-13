import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';

// Re-frames a finished 9:16 (1080x1920) short into 16:9 or 1:1 without touching its layout: the original is scaled to fit
// the frame and the sides are filled with a blurred, dimmed copy of the same picture (renders the short twice).
// Not for shots that read useVideoConfig() width/height (the vox collage kit does).
export const SRC_W = 1080;
export const SRC_H = 1920;

export const RATIOS = {
  '16x9': { width: 1920, height: 1080 },
  '1x1': { width: 1080, height: 1080 },
} as const;
export type RatioKey = keyof typeof RATIOS;

export const AspectFrame: React.FC<{ Comp: React.FC; blur?: number }> = ({ Comp, blur = 36 }) => {
  const { width, height } = useVideoConfig();
  const fit = Math.min(width / SRC_W, height / SRC_H);
  const fill = Math.max(width / SRC_W, height / SRC_H);
  const place = (s: number): React.CSSProperties => ({
    position: 'absolute', width: SRC_W, height: SRC_H, left: (width - SRC_W) / 2, top: (height - SRC_H) / 2,
    transform: `scale(${s})`, transformOrigin: 'center center',
  });
  return (
    <AbsoluteFill style={{ background: '#000', overflow: 'hidden' }}>
      <div style={{ ...place(fill), filter: `blur(${blur}px) brightness(0.55)` }}><Comp /></div>
      <div style={place(fit)}><Comp /></div>
    </AbsoluteFill>
  );
};
