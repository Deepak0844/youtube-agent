import { z } from "zod";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { audibilityCheck } from "@/server/core/mix-graph";
import type { SfxPlan } from "@/server/core/sfx-plan";

// Pure helpers for the video page's Sound tab: the owner's bed choice, its hash, the cue list and the audibility verdicts. No IO.

/** The music bed the owner picked for one video (videos/<id>/sound-bed.json). The Sound step lays it over any bed in the plan. */
export const BedChoice = z.object({ item: z.string().min(1), gainDb: z.number().min(-30).max(0), loop: z.boolean() });
export type BedChoice = z.infer<typeof BedChoice>;
export const DEFAULT_BED_GAIN_DB = -22;

/** Short stable hash of a bed choice (null = no bed). The Sound step stores it in its result; a different hash on the page means the sound is out of date. */
export const bedChoiceHash = (b: BedChoice | null): string => sha256Hex(canonicalJson(b === null ? { bed: null } : { bed: { item: b.item, gainDb: b.gainDb, loop: b.loop } })).slice(0, 16);

/** The plan with the owner's bed laid over it (the plan is returned untouched when there is no choice). */
export const withBedChoice = (plan: SfxPlan, b: BedChoice | null): SfxPlan => (b ? { ...plan, bed: { item: b.item, gainDb: b.gainDb, loop: b.loop } } : plan);

/** A bed should sit well under the voice but still be there: this many dB under the voice's mean level. */
export const BED_UNDER_VOICE_MIN_DB = 10;
export const BED_UNDER_VOICE_MAX_DB = 32;

export interface Verdict { id: string; audible: boolean; headroomDb: number }

/** Bed: audible when its mean level is 10 to 32 dB under the voice mean (not fighting the voice, not buried). headroomDb = distance to the nearer edge. */
export function bedAudibility(bedRmsDb: number, voiceMeanDb: number): Verdict {
  const under = voiceMeanDb - bedRmsDb;
  const headroomDb = Math.min(under - BED_UNDER_VOICE_MIN_DB, BED_UNDER_VOICE_MAX_DB - under);
  return { id: "bed", audible: headroomDb >= 0, headroomDb };
}

/** Per-cue verdict, the same rule the mixer uses to drop or refuse a cue. */
export const cueAudibility = (id: string, cueRmsDb: number, voiceRmsDbAtCue: number): Verdict => ({ id, ...audibilityCheck({ id }, { cueRmsDb, voiceRmsDbAtCue }) });

export interface CueRow { atS: number | null; kind: "sound" | "bed"; label: string; levelDb: number; optional: boolean }

/** Rows for the cue sheet: the bed first, then cues in time order. `names` maps library item id to its name. */
export function cueRows(plan: SfxPlan, names: ReadonlyMap<string, string>): CueRow[] {
  const bed: CueRow[] = plan.bed ? [{ atS: null, kind: "bed", label: names.get(plan.bed.item) ?? plan.bed.item, levelDb: plan.bed.gainDb, optional: false }] : [];
  const cues = [...plan.cues].sort((a, b) => a.atS - b.atS).map((c): CueRow => ({ atS: c.atS, kind: "sound", label: c.note ?? names.get(c.itemId) ?? c.id, levelDb: c.gainDb, optional: c.optional }));
  return [...bed, ...cues];
}

/** Reads the audibility list the Sound step saved in its result; anything malformed is ignored. */
export function parseVerdicts(raw: unknown): Verdict[] {
  const r = z.array(z.object({ id: z.string(), audible: z.boolean(), headroomDb: z.number() })).safeParse(raw);
  return r.success ? r.data : [];
}
