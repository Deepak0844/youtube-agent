// How a model is scaled to a size: pure, so a unit test can load it without three.js.
/** What the catalogue manifest says about a model (all optional): used when you do not give a size. */
export type ModelInfo = { default_scale?: number; pivot?: "bottom" | "center"; bounds_m?: { x: number; y: number; z: number } };

export type FitOptions = {
  /** Longest side in metres (or the height when `height` is true). */
  size?: number;
  /** Fit the HEIGHT to `size` (people, lamps, trees) instead of the longest side. */
  height?: boolean;
  /** Catalogue manifest entry: its default_scale applies when no size is given. */
  info?: ModelInfo;
  /** Tone metals down (they go black without a rich environment); default true. */
  matte?: boolean;
};

/** Scale factor that makes a model of `dims` metres meet the request. Pure, unit-tested. */
export function fitScale(dims: { x: number; y: number; z: number }, o: FitOptions): number {
  if (o.size !== undefined) return o.size / ((o.height ? dims.y : Math.max(dims.x, dims.y, dims.z)) || 1);
  return o.info?.default_scale ?? 1;
}

