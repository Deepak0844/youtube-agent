import { z } from "zod";
import { assetId, base, copy, LIMITS } from "./common";

export const schema = z.object({
  ...base,
  kind: z.literal("stock_clip"),
  asset: assetId, // stock video or image; the renderer resolves the id
  dim: z.number().min(0).max(0.8).default(0.25), // black overlay so captions stay readable
  caption: copy(LIMITS.caption).optional(),
  captionZone: z.enum(["upper_safe", "lower_safe"]).default("lower_safe"),
});

export const describe = `kind "stock_clip": asset (stock video or image asset id, never a URL or path), dim 0-0.8 (default 0.25), optional caption (max ${LIMITS.caption}), captionZone "upper_safe"|"lower_safe".`;
