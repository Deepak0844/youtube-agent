import { z } from "zod";
import { assetId, base, copy, LIMITS } from "./common";

// Re-frame must skip collage shots (remotion/kit/reframe.ts shouldReframe); keep this id in sync.
export const KIND = "collage";

export const schema = z.object({
  ...base,
  kind: z.literal(KIND),
  layout: z.enum(["grid2", "grid3", "hero_plus_strip", "stagger"]),
  // Tiles fill the layout slots in order. Tile order is also the reveal order.
  tiles: z
    .array(
      z.object({
        asset: assetId,
        media: z.enum(["image", "clip"]).default("image"),
        enter: z.enum(["fade", "pop", "slide_left", "slide_right", "rise"]).default("fade"),
        // Extra wait after the previous tile, in ms.
        delayMs: z.number().int().min(0).max(LIMITS.tileDelayMs).default(300),
        caption: copy(LIMITS.tileCaption).optional(),
      }),
    )
    .min(2, "needs at least 2 tiles")
    .max(LIMITS.collageTiles, `must have at most ${LIMITS.collageTiles} tiles`),
});

export const describe = `kind "collage": layout "grid2"|"grid3"|"hero_plus_strip"|"stagger", tiles (2-${LIMITS.collageTiles}, filled in slot order): asset (asset id, never a URL or path), media "image"|"clip", enter "fade"|"pop"|"slide_left"|"slide_right"|"rise", delayMs 0-${LIMITS.tileDelayMs}, optional caption (max ${LIMITS.tileCaption}).`;
