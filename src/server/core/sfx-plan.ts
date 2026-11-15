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

const CueSheetItem = z.object({ id: z.string().min(1).max(80), sound: z.string().min(1).max(60), atS: z.number().finite(), gainDb: z.number().finite().default(-12), optional: z.boolean().default(true) });

// A cue sheet is what an author writes: a recipe id from the sfx palette and a time. The plan needs library item ids.
export const CueSheet = z.object({
  cues: z.array(z.object({ id: z.string().min(1), sound: z.string().min(1), atS: z.number().min(0), gainDb: z.number().min(-30).max(6).default(-12), optional: z.boolean().default(true) })).max(60),
});
export type CueSheet = z.input<typeof CueSheet>;

/** Library only, never a paid clip: `find` returns the id of a library item for the recipe's tags. A cue with no clip in the library is dropped (the library may ship with few or no sounds): the video then has fewer effects, never a failure. */
export async function planFromCueSheet(sheet: CueSheet, palette: Palette, find: (tags: string[]) => Promise<string | undefined>): Promise<SfxPlan> {
  const cues: Cue[] = [];
  for (const c of CueSheet.parse(sheet).cues) {
    const recipe = palette.recipes.find((r) => r.id === c.sound);
    const itemId = recipe && (await find(recipe.tags));
    if (itemId) cues.push({ id: c.id, itemId, atS: c.atS, gainDb: c.gainDb, optional: c.optional });
  }
  return SfxPlan.parse({ version: 1, cues });
}

/** A cue sheet written by an engine run, made safe: anything that is not valid is dropped (never a failure: the video just has fewer effects).
 * Every cue becomes optional. Keeps cues with a real time inside the video, clamps gain to what the plan allows, drops a repeat of the same sound within 0.15 s, caps at 60. */
export function sanitizeCueSheet(raw: unknown, durationS: number): z.infer<typeof CueSheet> {
  const list = (raw as { cues?: unknown } | null)?.cues;
  if (!Array.isArray(list) || !(durationS > 0)) return { cues: [] };
  const cues: z.infer<typeof CueSheet>["cues"] = [];
  for (const item of list) {
    const c = CueSheetItem.safeParse(item);
    if (!c.success) continue;
    const { id, sound, atS } = c.data;
    if (atS < 0 || atS > durationS - 0.1) continue;
    const gainDb = Math.min(6, Math.max(-30, c.data.gainDb));
    if (cues.some((o) => o.sound === sound && Math.abs(o.atS - atS) < 0.15)) continue;
    cues.push({ id, sound, atS: Math.round(atS * 1000) / 1000, gainDb, optional: true }); // always optional: the Sound step drops a cue it cannot hear instead of failing the video
    if (cues.length === 60) break;
  }
  return { cues: cues.sort((a, b) => a.atS - b.atS) };
}
