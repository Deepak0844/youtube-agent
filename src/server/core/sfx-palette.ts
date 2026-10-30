import { z } from "zod";

// Reusable sound recipes (ported from the old app's palette.json). Pure: parse the JSON text the caller read.
// A recipe is what to ask the provider for; the library item it produces is catalogued by Task 12's ensureSound.

const recipe = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  duration_s: z.number().positive(),
  tags: z.array(z.string().min(1)).min(1), // library search is by tag: a recipe without tags could never be found
  prompt: z.string().min(1),
});
const defaults = z.object({ model: z.string().min(1), target_lufs: z.number(), ceiling_dbfs: z.number() }).passthrough();

const sfxFile = z.object({ defaults, sounds: z.array(recipe) });
const musicFile = z.object({ defaults, beds: z.array(recipe) });

export interface SoundRecipe { id: string; category: string; durationS: number; tags: string[]; prompt: string }
export interface Palette { kind: "sfx" | "music"; model: string; targetLufs: number; ceilingDbfs: number; recipes: SoundRecipe[] }

export function parsePalette(kind: "sfx" | "music", json: unknown): Palette {
  const { defaults: d, list } = kind === "sfx" ? (({ defaults, sounds }) => ({ defaults, list: sounds }))(sfxFile.parse(json)) : (({ defaults, beds }) => ({ defaults, list: beds }))(musicFile.parse(json));
  const ids = list.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${kind} palette has a repeated id`);
  return { kind, model: d.model, targetLufs: d.target_lufs, ceilingDbfs: d.ceiling_dbfs, recipes: list.map((r) => ({ id: r.id, category: r.category, durationS: r.duration_s, tags: r.tags, prompt: r.prompt })) };
}
