// The shape a drafted script must have before it is stored. Pure: no IO. Anything the model says about its own
// verification (verified / verified_by) is dropped: only the system verifies evidence.
import { z } from "zod";
import { wordCount, wordRange, type Lang } from "./lang";

const MAX_BYTES = 256 * 1024;
const CTA = /(comment below|let me know in the comments|subscribe|follow (me|for)|like (and|&) |smash that|hit the (bell|like)|which one should i|what should i (do|break down) next)/i;
const STRIPPED = new Set(["verified_by", "verified"]);

const httpUrl = z.string().refine((s) => {
  try {
    const p = new URL(s).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}, "must be an http(s) URL");

export const beatSchema = z.looseObject({ id: z.string().min(1) });
export const claimSchema = z.discriminatedUnion("kind", [
  z.object({ text: z.string().min(1), kind: z.literal("sourced"), source_url: httpUrl, quote: z.string().min(1) }),
  z.object({ text: z.string().min(1), kind: z.literal("computed"), method: z.string().min(1) }),
]);
export const scriptSchema = z.object({
  narration: z.string(),
  beats: z.array(beatSchema),
  title: z.string().min(1),
  description: z.string().optional(),
  evidence: z.array(claimSchema),
});
export type Beat = z.infer<typeof beatSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type Script = z.infer<typeof scriptSchema>;

/** Copy without verified/verified_by keys; records a problem for NUL characters. */
function clean(v: unknown, problems: string[]): unknown {
  if (typeof v === "string") {
    if (v.includes("\u0000")) problems.push("contains a NUL character");
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => clean(x, problems));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !STRIPPED.has(k)).map(([k, x]) => [k, clean(x, problems)]));
  }
  return v;
}

export function validateScript(
  script: unknown,
  lang: Lang,
  format: "short" | "long",
  opts: { requireEvidence?: boolean; speakingRate?: number } = {},
): { ok: true; script: Script } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(script) ?? "");
  } catch {
    return { ok: false, problems: ["script is not plain JSON"] };
  }
  if (bytes > MAX_BYTES) return { ok: false, problems: ["script is over 256 KB"] };

  const parsed = scriptSchema.safeParse(clean(script, problems));
  if (problems.length) return { ok: false, problems: [...new Set(problems)] };
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "script"}: ${i.message}`) };
  const s = parsed.data;

  if (format === "short") {
    const words = wordCount(s.narration);
    const { min, max } = wordRange(lang, opts.speakingRate);
    if (words < min || words > max) problems.push(`${words} spoken words (want ${min}-${max})`);
  }
  const cta = CTA.exec(s.narration);
  if (cta) problems.push(`engagement-CTA phrasing in the narration (${JSON.stringify(cta[0])}); end on the payoff instead`);
  if ((opts.requireEvidence ?? true) && s.evidence.length === 0) problems.push("evidence is empty but evidence is required");
  return problems.length ? { ok: false, problems } : { ok: true, script: s };
}
