import { z } from "zod";
import { CARTOON_STYLE_IDS } from "../../../remotion/kit/toon/styles";
import type { ToonCharacter } from "../../../remotion/kit/toon/context";

// The cast of a cartoon series: 1 to 8 named characters, each one the puppet / bust / cook options cartoon-shorts' makers accept. Untrusted: the engine writes
// it (cast.json) and the owner can clear it. Pure.

export const CAST_LIMITS = { characters: 8, name: 30, role: 120, optionText: 40 } as const;

/** The option names the style makers read (toon.js puppets, anime and manga busts, painted cook). Anything else is refused: a typo would silently draw the default. */
export const CAST_OPTION_KEYS: ReadonlySet<string> = new Set([
  // puppets (comic, paper figures)
  "skin", "skinD", "shirt", "shirtD", "trim", "num", "numFill", "shorts", "shortsD", "pants", "shoe", "shoeD", "sole", "sock", "band", "hair", "beard", "headband",
  "top", "legs", "kid", "build", "hairStyle", "cap", "capD", "whistle", "scale", "glasses", "sleeve", "sleeveColor", "back", "tie",
  // busts (anime, manga)
  "skinS", "blushC", "hairS", "hairH", "iris", "irisL", "eyeW", "eyeH", "eyeGap", "lash", "jaw", "age", "frame", "outfit", "shirtS", "suit", "suitS", "collar", "stubble",
  "head", "nose", "pupil", "mouthW",
  // painted cook
  "apron",
]);

const optionValue = z.union([z.string().max(CAST_LIMITS.optionText), z.number().finite(), z.boolean(), z.null()]);

export const castSchema = z
  .array(
    z.strictObject({
      name: z.string().trim().min(1, "A character needs a name.").max(CAST_LIMITS.name, `A character name is at most ${CAST_LIMITS.name} characters.`),
      role: z.string().trim().max(CAST_LIMITS.role, `A role is at most ${CAST_LIMITS.role} characters.`),
      style: z.enum(CARTOON_STYLE_IDS, "A character's style must be one of the cartoon styles."),
      options: z.record(z.string(), optionValue),
    }),
  )
  .min(1, "The cast needs at least one character.")
  .max(CAST_LIMITS.characters, `The cast has at most ${CAST_LIMITS.characters} characters.`);

export function parseCast(json: unknown): { ok: true; cast: ToonCharacter[] } | { ok: false; message: string } {
  const r = castSchema.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, message: `${i?.path.length ? `${i.path.join(".")}: ` : ""}${i?.message ?? "The cast is not valid."}` };
  }
  const seen = new Set<string>();
  for (const c of r.data) {
    const k = c.name.toLowerCase();
    if (seen.has(k)) return { ok: false, message: `Two characters are called "${c.name}". Names must be different.` };
    seen.add(k);
    for (const key of Object.keys(c.options)) if (!CAST_OPTION_KEYS.has(key)) return { ok: false, message: `${c.name}: '${key.slice(0, 30)}' is not a look option the cartoon styles know.` };
  }
  return { ok: true, cast: r.data as ToonCharacter[] };
}
