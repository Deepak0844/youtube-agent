// Shared building blocks for scene kinds. Kind files import from here, never from ../schema.
import { z } from "zod";

/** Limits live in one place so errors, prompts and tests agree. */
export const LIMITS = {
  maxScenes: 40,
  minSceneMs: 500,
  maxSceneMs: 20_000,
  maxTotalMs: 180_000,
  title: 60,
  terminalLines: 8,
  terminalPrompt: 12,
  terminalText: 56,
  chatMessages: 6,
  chatText: 90,
  caption: 80,
  drawnObjects: 4,
  objectLabel: 20,
  networkNodes: 6,
  networkLinks: 8,
  nodeLabel: 14,
  packetLabel: 10,
} as const;

// Asset refs are opaque ids from the asset library, never URLs or paths.
export const assetId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "must be an asset id like 'img_ab12' (no URLs, paths or dots)");

export const copy = (max: number) => z.string().trim().min(1, "must not be empty").max(max, `must be at most ${max} characters`);

export const base = {
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
