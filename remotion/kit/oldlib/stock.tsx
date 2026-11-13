import React from 'react';
import { AbsoluteFill, Img, OffthreadVideo, staticFile } from 'remotion';

// Stock / uploaded footage (tools/stock.py puts it in media/projects/<proj>/stock/). Cover-fits any frame ratio,
// optional dim for caption legibility. src is relative to media/, e.g. 'projects/short-19/stock/pexels-123.mp4'.
const isImage = (s: string) => /\.(jpe?g|png|webp)$/i.test(s);

export const StockClip: React.FC<{
  src: string;
  dim?: number;          // 0..1 black overlay
  startFrom?: number;    // frames to skip into the clip
  style?: React.CSSProperties;
}> = ({ src, dim = 0.25, startFrom = 0, style }) => (
  <AbsoluteFill style={{ background: '#000', ...style }}>
    {isImage(src) ? (
      <Img src={staticFile(src)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    ) : (
      <OffthreadVideo src={staticFile(src)} muted startFrom={startFrom} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    )}
    {dim > 0 ? <AbsoluteFill style={{ background: `rgba(0,0,0,${dim})` }} /> : null}
  </AbsoluteFill>
);
