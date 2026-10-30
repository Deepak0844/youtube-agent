import { z } from "zod";
import type { Palette } from "@/server/core/sfx-palette";

// The sound plan for one video: cues on the master timeline plus an optional music bed. No IO here.
export const Cue = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  atS: z.number().min(0),
  gainDb: z.number().min(-30).max(6),
  optional: z.boolean(),
  hero: z.boolean().optional(),
  note: z.string().optional(),
});
export type Cue = z.infer<typeof Cue>;

export const SfxPlan = z.object({
  version: z.literal(1),
  cues: z.array(Cue).max(60),
  bed: z.object({ item: z.string(), gainDb: z.number().min(-30).max(0), loop: z.boolean() }).optional(),
});
export type SfxPlan = z.infer<typeof SfxPlan>;

/** Printable table in plan order: time, name, gain, optional. */
export function cueSheet(plan: SfxPlan): string {
  const rows = plan.cues.map((c) => `${c.atS.toFixed(2).padStart(8)}  ${(c.note ?? c.id).padEnd(24)}  ${c.gainDb.toFixed(1).padStart(6)} dB  ${c.optional ? "optional" : "required"}`);
  const bed = plan.bed ? [`bed: ${plan.bed.item} at ${plan.bed.gainDb} dB${plan.bed.loop ? ", looped" : ""}`] : [];
  return ["time(s)  name                      gain      optional", ...rows, ...bed].join("\n") + "\n";
}

// A cue sheet is what an author writes: a recipe id from the sfx palette and a time. The plan needs library item ids.
export const CueSheet = z.object({
  cues: z.array(z.object({ id: z.string().min(1), sound: z.string().min(1), atS: z.number().min(0), gainDb: z.number().min(-30).max(6).default(-12), optional: z.boolean().default(true) })).max(60),
});
export type CueSheet = z.input<typeof CueSheet>;

/** Library only, never a paid clip: `find` returns the id of a library item for the recipe's tags. A missing optional clip is dropped; a missing required one fails. */
export async function planFromCueSheet(sheet: CueSheet, palette: Palette, find: (tags: string[]) => Promise<string | undefined>): Promise<SfxPlan> {
  const cues: Cue[] = [];
  for (const c of CueSheet.parse(sheet).cues) {
    const recipe = palette.recipes.find((r) => r.id === c.sound);
    const itemId = recipe && (await find(recipe.tags));
    if (itemId) cues.push({ id: c.id, itemId, atS: c.atS, gainDb: c.gainDb, optional: c.optional });
    else if (!c.optional) throw new Error(`cue ${c.id}: no library clip for "${c.sound}"`);
  }
  return SfxPlan.parse({ version: 1, cues });
}
