// Portrait scene JSON: the form an LLM fills and the Remotion kit renders.
// Pure zod, no app imports, so both src/ and remotion/ can use it.
import { z } from "zod";

export const SCENE_SCHEMA_VERSION = 1;

/** Limits live in one place so errors, prompts and tests agree. */
export const LIMITS = {
  maxScenes: 40,
  minSceneMs: 500,
  maxSceneMs: 20_000,
  maxTotalMs: 180_000,
  title: 60,
  terminalLines: 8,
  terminalPrompt: 12,
  terminalText: 40,
  chatMessages: 6,
  chatText: 90,
  caption: 80,
} as const;

// Asset refs are opaque ids from the asset library, never URLs or paths.
const assetId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "must be an asset id like 'img_ab12' (no URLs, paths or dots)");

const copy = (max: number) => z.string().trim().min(1, "must not be empty").max(max, `must be at most ${max} characters`);

const base = {
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/, "must be 1-32 chars of a-z, 0-9, _ or -"),
  // Which script beat this scene shows; the voice line for the beat sets the timing.
  beat: z.string().regex(/^[a-z0-9_-]{1,32}$/, "must be a beat id from the script"),
  startMs: z.number().int().min(0, "must be 0 or more"),
  durationMs: z
    .number()
    .int()
    .min(LIMITS.minSceneMs, `must be at least ${LIMITS.minSceneMs} ms`)
    .max(LIMITS.maxSceneMs, `must be at most ${LIMITS.maxSceneMs} ms`),
};

const terminal = z.object({
  ...base,
  kind: z.literal("terminal"),
  title: copy(LIMITS.title).optional(),
  lines: z
    .array(
      z.object({
        prompt: copy(LIMITS.terminalPrompt).default("$"), // per-line prompt
        text: copy(LIMITS.terminalText),
        output: z.boolean().default(false), // true = printed output, no typing
      }),
    )
    .min(1)
    .max(LIMITS.terminalLines, `must have at most ${LIMITS.terminalLines} lines`),
});

const chatThread = z.object({
  ...base,
  kind: z.literal("chat_thread"),
  messages: z
    .array(z.object({ from: z.enum(["user", "assistant"]), text: copy(LIMITS.chatText) }))
    .min(1)
    .max(LIMITS.chatMessages, `must have at most ${LIMITS.chatMessages} messages`),
});

const storyKenburns = z.object({
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

export const sceneSchema = z.discriminatedUnion("kind", [terminal, chatThread, storyKenburns]);

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
