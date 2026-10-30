import { z } from "zod";
import { assetId, base, copy, LIMITS } from "./common";

export const schema = z.object({
  ...base,
  kind: z.literal("story_kenburns"),
  image: assetId,
  caption: copy(LIMITS.caption).optional(),
  // Only safe-area zones; no free coordinates.
  captionZone: z.enum(["upper_safe", "lower_safe"]).default("lower_safe"),
  zoomFrom: z.number().min(1).max(1.5).default(1),
  zoomTo: z.number().min(1).max(1.5).default(1.2),
  // Pan as a fraction of the frame, small so the image never leaves it.
  panX: z.number().min(-0.15).max(0.15).default(0),
  panY: z.number().min(-0.15).max(0.15).default(0),
});

export const describe = `kind "story_kenburns": image (asset id, never a URL or path), optional caption (max ${LIMITS.caption}), captionZone "upper_safe"|"lower_safe", zoomFrom/zoomTo 1-1.5, panX/panY -0.15..0.15.`;
