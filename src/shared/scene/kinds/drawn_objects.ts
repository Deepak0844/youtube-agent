import { z } from "zod";
import { base, copy, LIMITS } from "./common";

export const OBJECT_IDS = ["jug", "measuring_cup", "ruler", "laptop", "server_rack", "container", "cloud", "padlock"] as const;
export const OBJECT_SLOTS = ["left", "center", "right"] as const;
export const OBJECT_ENTERS = ["fade", "pop", "slide_up"] as const;
export const OBJECT_EMPHASIS = ["none", "pulse", "wiggle"] as const;

export const schema = z.object({
  ...base,
  kind: z.literal("drawn_objects"),
  objects: z
    .array(
      z.object({
        object: z.enum(OBJECT_IDS),
        label: copy(LIMITS.objectLabel).optional(),
        slot: z.enum(OBJECT_SLOTS).default("center"), // objects stack top to bottom in list order
        enter: z.enum(OBJECT_ENTERS).default("fade"),
        emphasis: z.enum(OBJECT_EMPHASIS).default("none"),
      }),
    )
    .min(1)
    .max(LIMITS.drawnObjects, `must have at most ${LIMITS.drawnObjects} objects`),
});

export const describe = `kind "drawn_objects": objects[] (1-${LIMITS.drawnObjects}, stacked top to bottom), each {object (one of ${OBJECT_IDS.join(", ")}), label (optional, max ${LIMITS.objectLabel} chars), slot (${OBJECT_SLOTS.join("|")}, default center), enter (${OBJECT_ENTERS.join("|")}, default fade), emphasis (${OBJECT_EMPHASIS.join("|")}, default none)}.`;
