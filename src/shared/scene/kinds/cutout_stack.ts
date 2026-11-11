import { z } from "zod";
import { assetId, base, copy, LIMITS } from "./common";

// Re-frame must skip cut-out shots (remotion/kit/reframeMath.ts shouldReframe): they lay out against the stage, like collage. Keep this id in sync.
export const KIND = "cutout_stack";

export const schema = z.object({
  ...base,
  kind: z.literal(KIND),
  // Cut-out pictures (see-through background), arranged by the renderer: 1 big in the middle, 2 side by side, 3 a triangle, 4 a block, 5 a hero with four around.
  // Layer order is the reveal order (the first layer is behind the others).
  layers: z
    .array(
      z.object({
        asset: assetId,
        enter: z.enum(["fade", "pop", "slide_left", "slide_right", "rise"]).default("pop"),
        // Extra wait after the previous layer, in ms.
        delayMs: z.number().int().min(0).max(LIMITS.tileDelayMs).default(250),
      }),
    )
    .min(1, "needs at least 1 layer")
    .max(LIMITS.cutoutLayers, `must have at most ${LIMITS.cutoutLayers} layers`),
  // A soft panel behind the layers so they stay readable on any look (the contrast rule). On unless you turn it off.
  backing: z.boolean().default(true),
  caption: copy(LIMITS.caption).optional(),
  captionZone: z.enum(["upper_safe", "lower_safe"]).default("lower_safe"),
});

export const describe = `kind "cutout_stack": layers (1-${LIMITS.cutoutLayers}, the first is behind): asset (a cut-out picture asset id, never a URL or path), enter "fade"|"pop"|"slide_left"|"slide_right"|"rise" (default pop), delayMs 0-${LIMITS.tileDelayMs} (default 250); backing true|false (default true, a soft panel so the layers stay readable); optional caption (max ${LIMITS.caption}); captionZone "upper_safe"|"lower_safe" (default lower_safe). The renderer places the layers.`;
