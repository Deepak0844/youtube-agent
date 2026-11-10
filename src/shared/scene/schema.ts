// Portrait scene JSON: the form an LLM fills and the Remotion kit renders.
// Pure zod, no app imports, so both src/ and remotion/ can use it.
import { z } from "zod";
import { LIMITS, LONG_LIMITS } from "./kinds/common";
import { kinds } from "./kinds";

export { LIMITS, LONG_LIMITS };

export const SCENE_SCHEMA_VERSION = 1;

type KindSchema = (typeof kinds)[keyof typeof kinds]["schema"];
export const sceneSchema = z.discriminatedUnion(
  "kind",
  Object.values(kinds).map((k) => k.schema) as unknown as [KindSchema, ...KindSchema[]],
);

const docSchema = (maxScenes: number, maxTotalMs: number) =>
  z
  .object({
    version: z.literal(SCENE_SCHEMA_VERSION),
    scenes: z.array(sceneSchema).min(1).max(maxScenes, `must have at most ${maxScenes} scenes`),
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
    if (end > maxTotalMs)
      ctx.addIssue({ code: "custom", path: ["scenes"], message: `total length ${end} ms exceeds ${maxTotalMs} ms` });
  });

export const sceneDocSchema = docSchema(LIMITS.maxScenes, LIMITS.maxTotalMs);
/** A long video's scenes: the same rules with a wider scene count and total length (Phase 6b). */
export const longSceneDocSchema = docSchema(LONG_LIMITS.maxScenes, LONG_LIMITS.maxTotalMs);

export type Scene = z.infer<typeof sceneSchema>;
export type SceneDoc = z.infer<typeof sceneDocSchema>;
