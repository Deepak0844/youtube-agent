import { z } from "zod";

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
