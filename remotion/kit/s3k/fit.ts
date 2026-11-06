// How a model is scaled to a size: pure, so a unit test can load it without three.js.
/** What the catalogue manifest says about a model (all optional): used when you do not give a size. */
export type ModelInfo = { default_scale?: number; pivot?: "bottom" | "center"; bounds_m?: { x: number; y: number; z: number } };

/**
 * True only for a RELATIVE model path (a staged catalogue file): letters, digits, _ - . and / segments ending in .glb, no scheme (http:, file:,
 * data:, blob:), no leading //, no '..', no backslash, at most 200 characters. useModels refuses every other URL a resolver returns, so a
 * scene-supplied resolver cannot make the loader request anything but a file served by the render's own bundle server.
 */
export const safeModelUrl = (url: unknown): url is string =>
  typeof url === "string" && url.length <= 200 && /^\/?(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.glb$/.test(url) && !url.includes("..");
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

