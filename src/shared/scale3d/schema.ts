// 3D scale-comparison description: pure data the author fills and the Scale3D composition renders.
// No 3D code is ever written by an LLM: every object is a kind from a fixed model library. Pure zod, no app imports.
import { z } from "zod";

export const SCALE3D_KINDS = ["tower_crane", "small_crane", "skyscraper", "half_built_tower", "house_row", "tree", "person", "ship", "mountain"] as const;
export type Scale3dKind = (typeof SCALE3D_KINDS)[number];

export const SCALE3D_LIMITS = {
  maxObjects: 12,
  maxBeats: 12,
  minTotalS: 30,
  maxTotalS: 45,
  minBeatS: 1.5,
  maxBeatS: 12,
  minHeightM: 0.1,
  maxHeightM: 9000,
  maxLabel: 28,
  maxCaption: 140,
} as const;

const L = SCALE3D_LIMITS;
const id = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, "must be lowercase letters, digits and underscores, starting with a letter");

/** A height is a claim: it carries either a quoted source or the way it was worked out, so the Evidence tab can check it. */
const claim = z.union([
  z.object({ source_url: z.url().max(500), quote: z.string().min(3).max(400) }).strict(),
  z.object({ method: z.string().min(3).max(400) }).strict(),
]);

export const scale3dObjectSchema = z
  .object({
    id,
    kind: z.enum(SCALE3D_KINDS),
    label: z.string().min(1).max(L.maxLabel),
    height_m: z.number().min(L.minHeightM).max(L.maxHeightM),
    claim,
    /** A tower crane can hold one other object on its hook (the "crane lifts crane" shot). Names that object's id. */
    carries: id.optional(),
  })
  .strict();

export const scale3dBeatSchema = z
  .object({
    /** The object the camera looks at (sideways position and framing). */
    focus: id,
    /** Optional height band (metres). The camera climbs from the low to the high end during the beat. Default: the whole object. */
    range_m: z.tuple([z.number().min(0).max(L.maxHeightM), z.number().min(0).max(L.maxHeightM)]).optional(),
    duration_s: z.number().min(L.minBeatS).max(L.maxBeatS),
    /** The big text on screen. */
    label: z.string().min(1).max(L.maxLabel),
    /** The sentence spoken over the beat (shown as captions once narration timings exist). */
    caption: z.string().min(1).max(L.maxCaption),
  })
  .strict();

export const scale3dSceneSchema = z
  .object({
    version: z.literal(1),
    objects: z.array(scale3dObjectSchema).min(1).max(L.maxObjects),
    beats: z.array(scale3dBeatSchema).min(2).max(L.maxBeats),
    ruler: z
      .object({
        /** Top of the ruler in metres. Default: just above the highest camera height. */
        max_m: z.number().min(1).max(L.maxHeightM).optional(),
        show_ticks: z.boolean().default(true),
      })
      .strict()
      .default({ show_ticks: true }),
    /** End on the first view so the video loops. */
    loop_back: z.boolean().default(true),
  })
  .strict();

export type Scale3dObject = z.infer<typeof scale3dObjectSchema>;
export type Scale3dBeat = z.infer<typeof scale3dBeatSchema>;
export type Scale3dScene = z.infer<typeof scale3dSceneSchema>;
