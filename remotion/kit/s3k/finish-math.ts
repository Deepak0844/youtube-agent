// Finish knobs and their limits: pure, so a unit test can load them without three.js or React.
export type FinishProps = {
  /** What is in focus: a world point [x, y, z] (depth of field follows the distance to it), a distance in metres, or nothing = the camera rig's target. */
  focus?: [number, number, number] | number;
  /** "full" (default) = everything on; "fast" = no AO, no depth of field, 2x MSAA, for quick previews. */
  mode?: "full" | "fast";
  /** Ambient occlusion on/off (default on in full mode). */
  ao?: boolean;
  /** Depth of field strength: 0 = off, 1 = default (default 1 in full mode). Limit 0..3. */
  dof?: number;
  /** Bloom strength 0..1.5 (default 0.32). */
  bloom?: number;
  /** Corner darkening 0..0.8 (default 0.42). */
  vignette?: number;
  /** Saturation multiplier 0.5..1.5 (default 1.08). */
  saturation?: number;
};

export const FINISH_DEFAULTS = { bloom: 0.32, vignette: 0.42, saturation: 1.08, dof: 1 } as const;
export const FINISH_LIMITS = { dof: [0, 3], bloom: [0, 1.5], vignette: [0, 0.8], saturation: [0.5, 1.5] } as const;

/** Clamps every knob into its limit and applies the mode, so a model-written value can never break the picture. Pure. */
export function resolveFinish(p: FinishProps): { ao: boolean; dof: number; bloom: number; vignette: number; saturation: number; samples: number } {
  const fast = p.mode === "fast";
  const c = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  return {
    ao: p.ao ?? !fast,
    dof: fast ? 0 : c(p.dof ?? FINISH_DEFAULTS.dof, FINISH_LIMITS.dof),
    bloom: c(p.bloom ?? FINISH_DEFAULTS.bloom, FINISH_LIMITS.bloom),
    vignette: c(p.vignette ?? FINISH_DEFAULTS.vignette, FINISH_LIMITS.vignette),
    saturation: c(p.saturation ?? FINISH_DEFAULTS.saturation, FINISH_LIMITS.saturation),
    samples: fast ? 2 : 4,
  };
}

