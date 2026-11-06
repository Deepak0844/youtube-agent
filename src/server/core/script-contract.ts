// The shape a drafted script must have before it is stored. Pure: no IO. Anything the model says about its own
// verification (verified / verified_by) is dropped: only the system verifies evidence.
import { z } from "zod";
import { checkBeatRoles } from "@/shared/scene/beat-roles";
import { SCALE3D_KINDS, SCALE3D_LIMITS } from "@/shared/scale3d/schema";
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

// visual / search: optional picture brief per beat (English plain nouns) that Build uses to pick honest scenes.
export const beatSchema = z.looseObject({
  id: z.string().min(1),
  visual: z.string().max(320).optional(),
  search: z.array(z.string().min(1).max(80)).max(5).optional(),
  /** Estimated seconds from the start, set at Draft save (2.7 words/sec); never rendered. */
  est_start: z.number().nonnegative().optional(),
  est_end: z.number().nonnegative().optional(),
});
export const claimSchema = z.discriminatedUnion("kind", [
  z.object({ text: z.string().min(1), kind: z.literal("sourced"), source_url: httpUrl, quote: z.string().min(1) }),
  z.object({ text: z.string().min(1), kind: z.literal("computed"), method: z.string().min(1) }),
]);
/**
 * One object of a 3D scale video's `scale` list: a model from the fixed library and its real height. The height is a claim, so it
 * carries a quoted source (source_url + quote) or the way it was worked out (method); validateScript turns each into an evidence claim.
 */
export const scaleItemSchema = z.object({
  label: z.string().trim().min(1).max(SCALE3D_LIMITS.maxLabel),
  kind: z.enum(SCALE3D_KINDS),
  height_m: z.number().min(SCALE3D_LIMITS.minHeightM).max(SCALE3D_LIMITS.maxHeightM),
  source_url: httpUrl.optional(),
  quote: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
});
export type ScaleItem = z.infer<typeof scaleItemSchema>;

export const STORY_LIMITS = { minBeats: 6, maxBeats: 12, maxVisual: 240, maxLine: 300 } as const;
/**
 * One beat of a 3D scene video's `story`: what we SEE (nouns: ship, crane, rock wall, skyline, sand, water) and the narration line spoken over it.
 * A fact in the line is a claim, so it carries a quoted source (source_url + quote) or the way it was worked out (method); validateScript
 * turns each into an evidence claim, the same way it does for the scale list.
 */
export const storyBeatSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "must be lowercase letters, digits and underscores, starting with a letter"),
  visual: z.string().trim().min(8).max(STORY_LIMITS.maxVisual),
  line: z.string().trim().min(1).max(STORY_LIMITS.maxLine),
  fact: z.string().trim().min(1).max(200).optional(),
  source_url: httpUrl.optional(),
  quote: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
});
export type StoryBeat = z.infer<typeof storyBeatSchema>;

/** Heights (metres) a real object of each library kind can have; anything outside is a typo or an invention. Generous on purpose. */
export const SCALE_KIND_HEIGHT_M: Readonly<Record<(typeof SCALE3D_KINDS)[number], readonly [number, number]>> = {
  person: [0.3, 2.8],
  tree: [0.5, 120],
  house_row: [3, 60],
  small_crane: [3, 120],
  tower_crane: [10, 250],
  ship: [3, 200],
  half_built_tower: [10, 1000],
  skyscraper: [30, 1000],
  mountain: [50, 9000],
};

export const scriptSchema = z.object({
  narration: z.string(),
  beats: z.array(beatSchema),
  title: z.string().min(1),
  description: z.string().optional(),
  /** What is actually computed or drawn on screen (e.g. the real binary-search steps); Build tells the scene picker. */
  shown_for_real: z.string().max(200).optional(),
  evidence: z.array(claimSchema),
  /** 3D scale videos only: the objects to compare, in the order the camera visits them. */
  scale: z.array(scaleItemSchema).max(SCALE3D_LIMITS.maxObjects).optional(),
  /** 3D scene videos only: 6-12 beats (hook, setup, process steps, reveal, loop), each with what we see and the line spoken over it. */
  story: z.array(storyBeatSchema).max(STORY_LIMITS.maxBeats).optional(),
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
  opts: { requireEvidence?: boolean; speakingRate?: number; kind?: string } = {},
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
  if (format === "short" && opts.kind === "scene_kit") problems.push(...checkBeatRoles(s.beats.map((b) => b.id)));
  let evidence = s.evidence;
  if (opts.kind === "scale3d") {
    const sc = checkScale(s.scale);
    problems.push(...sc.problems);
    evidence = [...s.evidence, ...sc.claims.filter((c) => !s.evidence.some((e) => e.text === c.text))];
  } else if (s.scale && opts.kind !== "scene3d" && opts.kind !== "scene3d_code") problems.push("scale is only for 3D scale videos");
  if (opts.kind === "scene3d" || opts.kind === "scene3d_code") {
    if (s.scale) problems.push("scale is only for 3D scale videos; a 3D scene video tells a story instead");
    const st = checkStory(s.story, wordCount(s.narration));
    problems.push(...st.problems);
    evidence = [...evidence, ...st.claims.filter((c) => !evidence.some((e) => e.text === c.text))];
  } else if (s.story) problems.push("story is only for 3D scene videos");
  const cta = CTA.exec(s.narration);
  if (cta) problems.push(`engagement-CTA phrasing in the narration (${JSON.stringify(cta[0])}); end on the payoff instead`);
  if ((opts.requireEvidence ?? true) && evidence.length === 0) problems.push("evidence is empty but evidence is required");
  return problems.length ? { ok: false, problems } : { ok: true, script: { ...s, evidence } };
}

/** The 3D scale list: at least two objects, each height believable for its kind and backed by a source quote or a method. Each becomes an evidence claim. */
function checkScale(scale: readonly ScaleItem[] | undefined): { problems: string[]; claims: Claim[] } {
  if (!scale || scale.length < 2) return { problems: ["scale: a 3D scale video needs a scale list of at least 2 objects"], claims: [] };
  const problems: string[] = [];
  const claims: Claim[] = [];
  const seen = new Set<string>();
  scale.forEach((o, i) => {
    const n = `scale ${i + 1}`;
    const [lo, hi] = SCALE_KIND_HEIGHT_M[o.kind];
    if (o.height_m < lo || o.height_m > hi) problems.push(`${n}: a ${o.kind} cannot be ${o.height_m} m tall (expected ${lo} to ${hi} m)`);
    const key = o.label.toLowerCase();
    if (seen.has(key)) problems.push(`${n}: the label is used twice`);
    seen.add(key);
    const text = `${o.label} is about ${o.height_m} m tall`;
    if (o.source_url && o.quote) claims.push({ text, kind: "sourced", source_url: o.source_url, quote: o.quote });
    else if (o.method) claims.push({ text, kind: "computed", method: o.method });
    else problems.push(`${n}: the height needs a source_url with a quote, or a method`);
  });
  return { problems, claims };
}

// A visual that only says "bigger/taller than" is a size comparison, which is the 3D scale kind, not a story.
const SIZE_ONLY = /\b(taller|bigger|larger|smaller|compar\w*|scale|times (as )?(tall|big|large)|next to a)\b/i;

/** The story of a 3D scene video: 6-12 distinct beats from hook to loop, each one sentence of what we see plus its line; facts become claims. */
function checkStory(story: readonly StoryBeat[] | undefined, narrationWords: number): { problems: string[]; claims: Claim[] } {
  const { minBeats, maxBeats } = STORY_LIMITS;
  if (!story || story.length < minBeats) return { problems: [`story: a 3D scene video needs a story of ${minBeats} to ${maxBeats} beats (hook, setup, the steps, reveal, loop)`], claims: [] };
  const problems: string[] = [];
  const claims: Claim[] = [];
  const seen = new Set<string>();
  story.forEach((b, i) => {
    const n = `story ${i + 1}`;
    if (seen.has(b.id)) problems.push(`${n}: the id "${b.id}" is used twice`);
    seen.add(b.id);
    if (/[.!?]\s+\S/.test(b.visual)) problems.push(`${n}: the visual must be ONE sentence of what we see`);
    if (b.fact) {
      if (b.source_url && b.quote) claims.push({ text: b.fact, kind: "sourced", source_url: b.source_url, quote: b.quote });
      else if (b.method) claims.push({ text: b.fact, kind: "computed", method: b.method });
      else problems.push(`${n}: the fact needs a source_url with a quote, or a method`);
    }
  });
  if (story[0]!.id !== "hook") problems.push('story: the first beat id must be "hook"');
  if (story[story.length - 1]!.id !== "loop") problems.push('story: the last beat id must be "loop"');
  if (story.every((b) => SIZE_ONLY.test(b.visual))) problems.push("story: every visual is a size comparison; a 3D scene video shows a process (what is built, moved or changed), use the 3D scale kind for comparisons");
  const lineWords = story.reduce((a, b) => a + wordCount(b.line), 0);
  if (narrationWords > 0 && Math.abs(lineWords - narrationWords) > Math.max(12, narrationWords * 0.2)) problems.push(`story: the beat lines add up to ${lineWords} words but the narration has ${narrationWords}; the lines must be the narration split into beats`);
  return { problems, claims };
}
