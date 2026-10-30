// Portrait scene JSON: the form an LLM fills and the Remotion kit renders.
// Pure zod, no app imports, so both src/ and remotion/ can use it.
import { z } from "zod";
import { LIMITS } from "./kinds/common";
import { kinds } from "./kinds";

export { LIMITS };

export const SCENE_SCHEMA_VERSION = 1;

type KindSchema = (typeof kinds)[keyof typeof kinds]["schema"];
export const sceneSchema = z.discriminatedUnion(
  "kind",
  Object.values(kinds).map((k) => k.schema) as unknown as [KindSchema, ...KindSchema[]],
);

export const sceneDocSchema = z
  .object({
    version: z.literal(SCENE_SCHEMA_VERSION),
    scenes: z.array(sceneSchema).min(1).max(LIMITS.maxScenes, `must have at most ${LIMITS.maxScenes} scenes`),
  })
  .superRefine((doc, ctx) => {
    let end = 0;
    const seen = new Set<string>();
    doc.scenes.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", path: ["scenes", i, "id"], message: `duplicate scene id '${s.id}'` });
      seen.add(s.id);
      if (s.startMs < end)
        ctx.addIssue({ code: "custom", path: ["scenes", i, "startMs"], message: `overlaps the previous scene (it ends at ${end} ms)` });
      end = Math.max(end, s.startMs + s.durationMs);
    });
    if (end > LIMITS.maxTotalMs)
      ctx.addIssue({ code: "custom", path: ["scenes"], message: `total length ${end} ms exceeds ${LIMITS.maxTotalMs} ms` });
  });

export type Scene = z.infer<typeof sceneSchema>;
export type SceneDoc = z.infer<typeof sceneDocSchema>;
