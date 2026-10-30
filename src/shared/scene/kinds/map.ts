import { z } from "zod";
import { base, copy, LIMITS } from "./common";

const marker = z.object({
  label: copy(LIMITS.mapLabel),
  lat: z.number().min(-90, "must be between -90 and 90").max(90, "must be between -90 and 90"),
  lon: z.number().min(-180, "must be between -180 and 180").max(180, "must be between -180 and 180"),
});

export const schema = z.object({
  ...base,
  kind: z.literal("map"),
  title: copy(LIMITS.title).optional(),
  region: z.enum(["world", "europe", "north_america", "south_america", "africa", "asia", "oceania"]).default("world"),
  markers: z.array(marker).min(1).max(LIMITS.mapMarkers, `must have at most ${LIMITS.mapMarkers} markers`),
  // true = draw a line through the markers in order.
  route: z.boolean().default(false),
});

export const describe = `kind "map": region "world"|"europe"|"north_america"|"south_america"|"africa"|"asia"|"oceania" (default world); markers[] (1-${LIMITS.mapMarkers}) each {label (max ${LIMITS.mapLabel}), lat -90..90, lon -180..180}; route (bool, line through markers in order); optional title (max ${LIMITS.title}). Markers outside the region are not shown.`;
