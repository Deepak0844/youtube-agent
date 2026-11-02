import type { Message } from "@/server/core/agent-loop";
import { KnownFailure } from "@/server/core/paid-call";
import { describeSceneFormat, kindBlurbs, LIMITS, usableKinds, validateScenes, type SceneDoc } from "@/shared/scene";
import { SVG_EXAMPLE } from "../../../remotion/kit/svgDiagram";
import { styleGuidance } from "../../../remotion/kit/presets";
import { checkSceneRules, validateAndCheck } from "@/shared/scene/rules";

// Build, scene kit: one model answer per script beat, each checked against the scene format, then assembled into one
// document. The app (not the model) sets scene id, beat id and timing, so the model cannot break the timeline. A wrong
// answer is retried (max 2) with the plain-text errors; the same errors twice in a row stop the retries. One beat that
// stays invalid fails the whole build: there is no partial document.

export const MAX_SCENE_RETRIES = 2;
const MS_PER_CHAR = 65; // no narration timings exist yet at Build: estimate from the beat text
const MAX_PICTURES = 6;
const BEAT_ID = /^[a-z0-9_-]{1,32}$/;

export interface SceneBeat {
  id: string;
  text: string;
  /** Picture brief from the script (English). */
  visual?: string;
  search?: string[];
}
/** One paid, reserved model call; returns the raw answer text. */
export type AskScene = (messages: Message[]) => Promise<string>;

/** The deterministic part of a beat that has linked pictures: one picture is a Ken Burns shot, 2-6 a collage, more are cut to 6, none = the model picks. */
export function planPictureBeat(ids: readonly string[], clips?: ReadonlySet<string>): { kind: "story_kenburns" | "collage" | "stock_clip"; assets: string[] } | null {
  const a = ids.slice(0, MAX_PICTURES);
  if (a.length === 0) return null;
  const clip = clips ? a.find((id) => clips.has(id)) : undefined;
  if (clip) return { kind: "stock_clip", assets: [clip] }; // a linked clip wins: one muted clip, trimmed to the beat
  return a.length === 1 ? { kind: "story_kenburns", assets: a } : { kind: "collage", assets: a };
}

/**
 * Keeps one picture from carrying many scenes: per beat (in order), drops ids that both of the previous 2 scenes already show, so no id
 * fills more than 2 scenes in a row. With only one distinct picture in the whole video it is used once (the first beat that has it).
 */
export function limitRepeats(lists: readonly (readonly string[])[]): string[][] {
  const distinct = new Set(lists.flat()).size;
  const used = new Set<string>();
  const out: string[][] = [];
  for (const list of lists) {
    const [p2, p1] = out.slice(-2);
    const keep = list.filter((id) => !(p1?.includes(id) && p2?.includes(id)) && (distinct > 1 || !used.has(id)));
    keep.forEach((id) => used.add(id));
    out.push(keep);
  }
  return out;
}

/** Errors when the scene does not use exactly these asset ids (collage: in this order). */
export function checkPictureIds(scene: Record<string, unknown>, ids: readonly string[]): string[] {
  const used = scene.kind === "collage" ? ((scene.tiles as Array<{ asset?: unknown }> | undefined) ?? []).map((t) => t.asset) : scene.kind === "stock_clip" ? [scene.asset] : [scene.image];
  return used.length === ids.length && used.every((u, i) => u === ids[i]) ? [] : [`scene 1: the picture ids must be exactly ${ids.map((i) => `'${i}'`).join(", ")}${ids.length > 1 ? " in this order" : ""}`];
}

export function beatDurationMs(text: string): number {
  return Math.min(LIMITS.maxSceneMs, Math.max(LIMITS.minSceneMs, Math.round(text.length * MS_PER_CHAR)));
}

// Two small calls per beat instead of one call carrying all 18 kind descriptions (~6,700 tokens): first pick the kind from
// one-line blurbs, then fill it with ONLY that kind's description. Retries stay on the same kind.
/** The beat as the model sees it: its text plus the visual brief and search words when the script has them. */
export function beatBlock(beat: SceneBeat, shownForReal?: string): string {
  const brief = beat.visual ? `\nVisual brief: ${beat.visual}` : "";
  const search = beat.search?.length ? `\nSearch words: ${beat.search.join("; ")}` : "";
  const real = shownForReal ? `\nShown for real in this video: ${shownForReal}` : "";
  return `Beat ${beat.id}:\n${beat.text}${brief}${real}${search}`;
}

export function pickMessages(beat: SceneBeat, kinds: readonly string[], shownForReal?: string, style?: string | null): Message[] {
  const guide = styleGuidance(style); // "" for the default look, so the default prompt is unchanged
  return [
    { role: "system", content: `Pick the scene kind that best shows one beat of a short portrait video script. The visual brief is an on-screen action: choose the scene kind whose motion matches it (algo_cells for search or sort, orbit for planets and moons, network for packets and servers, chart for numbers, svg_diagram for any other mechanism, process or flow whose action is a motion and no picture or clip is linked: it draws a labelled animated diagram). When the brief describes motion, prefer a drawn or animated kind over a text kind. If no available kind can show it truthfully, choose the most abstract honest kind that fits the content (chart, math, chat, terminal, pause_card...). NEVER use drawn_objects unless the brief literally names one of its eight objects (jug, measuring_cup, ruler, laptop, server_rack, container, cloud, padlock).\nKinds:\n${kindBlurbs(kinds)}\nReply with only JSON: {"kind": "<one of the kinds>"}.${guide ? `\n${guide}` : ""}` },
    { role: "user", content: beatBlock(beat, shownForReal) },
  ];
}

export function fillMessages(beat: SceneBeat, kind: string, assets: readonly string[], opts: { exact?: boolean; language?: string } = {}): Message[] {
  const system = [
    "You turn one beat of a script into ONE scene of JSON for a short portrait video.",
    describeSceneFormat([kind]),
    opts.exact
      ? `The pictures for this beat are fixed. Use exactly these asset ids${assets.length > 1 ? ", in this order" : ""}: ${assets.join(", ")}. Write only a short caption${opts.language ? ` in the narration language (${opts.language})` : " in the narration language"}, based on the visual brief, and ${kind === "stock_clip" ? "leave dim at its default" : "choose a gentle pan/zoom or tile layout"}.`
      : assets.length > 0 ? `Allowed asset ids (use only these): ${assets.join(", ")}.` : "No images or clips exist for this video: do not use asset ids.",
    ...(kind === "svg_diagram" ? [`Example svg value (valid; copy its style, not its content). Inside the JSON string use single quotes for attributes and no line breaks, like this:\n${SVG_EXAMPLE.replace(/"/g, "'").replace(/\n/g, "")}`] : []),
    `Reply with only JSON: {"version": 1, "scenes": [ONE scene of kind "${kind}"]}. The app sets id, beat, startMs and durationMs: use id "s1", beat "${beat.id}", startMs 0, durationMs 3000.`,
  ].join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: beatBlock(beat) },
  ];
}

function checkPick(text: string, kinds: readonly string[]): { ok: true; value: string } | { ok: false; errors: string[] } {
  const raw = parseJson(text);
  const kind = raw && typeof raw === "object" ? (raw as { kind?: unknown }).kind : undefined;
  if (typeof kind === "string" && kinds.includes(kind)) return { ok: true, value: kind };
  return { ok: false, errors: [raw === undefined ? "The answer was not valid JSON." : `kind must be one of ${kinds.join(", ")}`] };
}

export function parseJson(text: string): unknown {
  const t = text.trim();
  const body = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)?.[1] ?? t;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Every asset id a scene (or a whole doc) points at: values of "asset" and "image" keys. */
export function assetRefs(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => assetRefs(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if ((k === "asset" || k === "image") && typeof x === "string") out.push(x);
      else assetRefs(x, out);
    }
  }
  return out;
}

/** Returns the single scene (the model's own ids and timing still in it) or plain-text errors. */
function check(text: string, kind: string, assets: readonly string[], visual?: string, exact = false): { ok: true; scene: Record<string, unknown> } | { ok: false; errors: string[] } {
  const raw = parseJson(text);
  if (raw === undefined) return { ok: false, errors: ["The answer was not valid JSON."] };
  const r = validateScenes(raw);
  if (!r.ok) return { ok: false, errors: r.errors };
  if (r.doc.scenes.length !== 1) return { ok: false, errors: [`must have exactly 1 scene, got ${r.doc.scenes.length}`] };
  const scene = r.doc.scenes[0]!;
  if (scene.kind !== kind) return { ok: false, errors: [`scene 1 > kind: must be '${kind}'`] };
  if (exact) {
    const e = checkPictureIds(scene as unknown as Record<string, unknown>, assets);
    if (e.length > 0) return { ok: false, errors: e };
  }
  const bad = [...new Set(assetRefs(scene).filter((a) => !assets.includes(a)))];
  if (bad.length > 0) return { ok: false, errors: [`scene 1: asset id ${bad.map((b) => `'${b}'`).join(", ")} does not exist for this video${assets.length ? `; allowed: ${assets.join(", ")}` : ""}`] };
  const rules = checkSceneRules({ ...r.doc, scenes: [{ ...scene, startMs: 0 }] }, { assetIds: [...assets], visual }); // the app sets timing, so judge the scene at 0 ms; house rules (no CTA wording, text cap, frame 0...) feed the same retry
  if (rules.length > 0) return { ok: false, errors: rules };
  return { ok: true, scene: scene as unknown as Record<string, unknown> };
}

/** Asks, checks, retries with the errors fed back (max 2); the same errors twice in a row stop. Returns the value or the last errors. */
export async function withRetries<T>(ask: AskScene, messages: Message[], check: (text: string) => { ok: true; value: T } | { ok: false; errors: string[] }): Promise<{ value: T } | { errors: string[] }> {
  let prev = "";
  for (let a = 0; ; a++) {
    const text = await ask(messages);
    const res = check(text);
    if (res.ok) return { value: res.value };
    const key = res.errors.join("\n");
    if (key === prev || a === MAX_SCENE_RETRIES) return { errors: res.errors };
    prev = key;
    messages.push({ role: "assistant", content: text.slice(0, 4000), toolCalls: [] });
    messages.push({ role: "user", content: `Your JSON was rejected:\n${res.errors.join("\n")}\nReply again with only the corrected JSON.` });
  }
}

export async function buildSceneDoc(beats: readonly SceneBeat[], ask: AskScene, opts: { assets?: readonly string[]; pictures?: Readonly<Record<string, readonly string[]>>; clips?: ReadonlySet<string>; language?: string; shownForReal?: string; style?: string | null } = {}): Promise<SceneDoc> {
  // With `pictures` (beat id -> linked asset ids) beats that have pictures are planned by the app and the rest never see image kinds.
  const perBeat = opts.pictures !== undefined;
  const limited = perBeat ? limitRepeats(beats.map((b) => (opts.pictures![b.id] ?? []).slice(0, MAX_PICTURES))) : [];
  const pictureOf = (i: number): string[] => limited[i] ?? [];
  const assets = perBeat ? [...new Set(limited.flat())] : (opts.assets ?? []);
  const kinds = usableKinds(!perBeat && assets.length > 0);
  // Everything that can be checked for free is checked BEFORE the first paid call.
  if (beats.length > LIMITS.maxScenes) throw new KnownFailure(`The script has ${beats.length} beats; the scene format allows at most ${LIMITS.maxScenes}. Shorten the script and draft again.`);
  for (const beat of beats) {
    if (!BEAT_ID.test(beat.id)) throw new KnownFailure(`Beat '${beat.id.slice(0, 40)}' has an id the scene format cannot use (1-32 chars of a-z, 0-9, _ or -). Fix the script and draft again.`);
  }
  const scenes: Record<string, unknown>[] = [];
  const noRepeat = (k: string[]): string[] => (scenes.length >= 2 && scenes.slice(-2).every((s) => s.kind === "svg_diagram") ? k.filter((x) => x !== "svg_diagram") : k); // never 3 diagrams in a row
  let startMs = 0;
  for (const [i, beat] of beats.entries()) {
    const fail = (errors: string[]) => new KnownFailure(`scenes_invalid: beat '${beat.id}' could not get a valid scene. Last problems: ${errors.slice(0, 5).join("; ")}`.slice(0, 600));
    const plan = perBeat ? planPictureBeat(pictureOf(i), opts.clips) : null;
    const beatAssets = perBeat ? (plan?.assets ?? []) : assets;
    let kind: string;
    if (plan) kind = plan.kind;
    else {
      const allowed = noRepeat(kinds);
      const pick = await withRetries(ask, pickMessages(beat, allowed, opts.shownForReal, opts.style), (t) => checkPick(t, allowed));
      if ("errors" in pick) throw fail(pick.errors);
      kind = pick.value;
    }
    const fill = await withRetries(ask, fillMessages(beat, kind, beatAssets, { exact: !!plan, language: opts.language }), (t) => {
      const r = check(t, kind, beatAssets, beat.visual, !!plan);
      return r.ok ? { ok: true, value: r.scene } : r;
    });
    if ("errors" in fill) throw fail(fill.errors);
    const durationMs = beatDurationMs(beat.text);
    scenes.push({ ...fill.value, id: `s${i + 1}`, beat: beat.id, startMs, durationMs });
    startMs += durationMs;
  }
  // Judge the assembled doc with the same per-beat visual briefs each scene was checked with, or the final check is stricter than the loop.
  const visualByBeat = Object.fromEntries(beats.flatMap((b) => (b.visual ? [[b.id, b.visual] as const] : [])));
  const doc = validateAndCheck({ version: 1, scenes }, { beats: beats.map((b) => b.id), assetIds: [...assets], visualByBeat });
  if (!doc.ok) throw new KnownFailure(`scenes_invalid: the assembled scenes do not fit. ${doc.errors.slice(0, 3).join("; ")}`.slice(0, 600));
  return doc.doc;
}
