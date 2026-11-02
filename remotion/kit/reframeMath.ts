// Pure geometry + rule for the re-frame render option (unit-tested; no Remotion imports).
export const SRC_W = 1080;
export const SRC_H = 1920;
export const REFRAME_RATIOS = { "16x9": { width: 1920, height: 1080 }, "1x1": { width: 1080, height: 1080 } } as const;

/** Scale for the sharp copy (fit), the blurred backdrop (fill), and the shared top-left offset. */
export function reframeGeometry(width: number, height: number) {
  return {
    fit: Math.min(width / SRC_W, height / SRC_H),
    fill: Math.max(width / SRC_W, height / SRC_H),
    left: (width - SRC_W) / 2,
    top: (height - SRC_H) / 2,
  };
}

const SKIP_KINDS = new Set(["collage"]);

/** False when re-framing would look wrong: transparent shots or collage shots (they lay out against the frame size). */
export function shouldReframe(p: { kinds: string[]; hasTransparency?: boolean }): boolean {
  return !p.hasTransparency && !p.kinds.some((k) => SKIP_KINDS.has(k));
}
