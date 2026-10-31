import type { Message } from "@/server/core/agent-loop";
import { KnownFailure } from "@/server/core/paid-call";
import { describeSceneFormat, kindBlurbs, LIMITS, usableKinds, validateScenes, type SceneDoc } from "@/shared/scene";
import { checkSceneRules, validateAndCheck } from "@/shared/scene/rules";

// Build, scene kit: one model answer per script beat, each checked against the scene format, then assembled into one
// document. The app (not the model) sets scene id, beat id and timing, so the model cannot break the timeline. A wrong
// answer is retried (max 2) with the plain-text errors; the same errors twice in a row stop the retries. One beat that
// stays invalid fails the whole build: there is no partial document.

export const MAX_SCENE_RETRIES = 2;
const MS_PER_CHAR = 65; // no narration timings exist yet at Build: estimate from the beat text
const BEAT_ID = /^[a-z0-9_-]{1,32}$/;

export interface SceneBeat {
  id: string;
  text: string;
}
/** One paid, reserved model call; returns the raw answer text. */
export type AskScene = (messages: Message[]) => Promise<string>;

export function beatDurationMs(text: string): number {
  return Math.min(LIMITS.maxSceneMs, Math.max(LIMITS.minSceneMs, Math.round(text.length * MS_PER_CHAR)));
}

// Two small calls per beat instead of one call carrying all 18 kind descriptions (~6,700 tokens): first pick the kind from
// one-line blurbs, then fill it with ONLY that kind's description. Retries stay on the same kind.
function pickMessages(beat: SceneBeat, kinds: readonly string[]): Message[] {
  return [
    { role: "system", content: `Pick the scene kind that best shows one beat of a short portrait video script.\nKinds:\n${kindBlurbs(kinds)}\nReply with only JSON: {"kind": "<one of the kinds>"}.` },
    { role: "user", content: `Beat ${beat.id}:\n${beat.text}` },
  ];
}

function fillMessages(beat: SceneBeat, kind: string, assets: readonly string[]): Message[] {
  const system = [
    "You turn one beat of a script into ONE scene of JSON for a short portrait video.",
    describeSceneFormat([kind]),
    assets.length > 0 ? `Allowed asset ids (use only these): ${assets.join(", ")}.` : "No images or clips exist for this video: do not use asset ids.",
    `Reply with only JSON: {"version": 1, "scenes": [ONE scene of kind "${kind}"]}. The app sets id, beat, startMs and durationMs: use id "s1", beat "${beat.id}", startMs 0, durationMs 3000.`,
  ].join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: `Beat ${beat.id}:\n${beat.text}` },
  ];
}

function checkPick(text: string, kinds: readonly string[]): { ok: true; value: string } | { ok: false; errors: string[] } {
  const raw = parseJson(text);
  const kind = raw && typeof raw === "object" ? (raw as { kind?: unknown }).kind : undefined;
  if (typeof kind === "string" && kinds.includes(kind)) return { ok: true, value: kind };
  return { ok: false, errors: [raw === undefined ? "The answer was not valid JSON." : `kind must be one of ${kinds.join(", ")}`] };
}

function parseJson(text: string): unknown {
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
function check(text: string, kind: string, assets: readonly string[]): { ok: true; scene: Record<string, unknown> } | { ok: false; errors: string[] } {
  const raw = parseJson(text);
  if (raw === undefined) return { ok: false, errors: ["The answer was not valid JSON."] };
  const r = validateScenes(raw);
  if (!r.ok) return { ok: false, errors: r.errors };
  if (r.doc.scenes.length !== 1) return { ok: false, errors: [`must have exactly 1 scene, got ${r.doc.scenes.length}`] };
  const scene = r.doc.scenes[0]!;
  if (scene.kind !== kind) return { ok: false, errors: [`scene 1 > kind: must be '${kind}'`] };
  const bad = [...new Set(assetRefs(scene).filter((a) => !assets.includes(a)))];
  if (bad.length > 0) return { ok: false, errors: [`scene 1: asset id ${bad.map((b) => `'${b}'`).join(", ")} does not exist for this video${assets.length ? `; allowed: ${assets.join(", ")}` : ""}`] };
  const rules = checkSceneRules({ ...r.doc, scenes: [{ ...scene, startMs: 0 }] }, { assetIds: [...assets] }); // the app sets timing, so judge the scene at 0 ms; house rules (no CTA wording, text cap, frame 0...) feed the same retry
  if (rules.length > 0) return { ok: false, errors: rules };
  return { ok: true, scene: scene as unknown as Record<string, unknown> };
}

/** Asks, checks, retries with the errors fed back (max 2); the same errors twice in a row stop. Returns the value or the last errors. */
async function withRetries<T>(ask: AskScene, messages: Message[], check: (text: string) => { ok: true; value: T } | { ok: false; errors: string[] }): Promise<{ value: T } | { errors: string[] }> {
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

export async function buildSceneDoc(beats: readonly SceneBeat[], ask: AskScene, opts: { assets?: readonly string[] } = {}): Promise<SceneDoc> {
  const assets = opts.assets ?? [];
  const kinds = usableKinds(assets.length > 0);
  // Everything that can be checked for free is checked BEFORE the first paid call.
  if (beats.length > LIMITS.maxScenes) throw new KnownFailure(`The script has ${beats.length} beats; the scene format allows at most ${LIMITS.maxScenes}. Shorten the script and draft again.`);
  for (const beat of beats) {
    if (!BEAT_ID.test(beat.id)) throw new KnownFailure(`Beat '${beat.id.slice(0, 40)}' has an id the scene format cannot use (1-32 chars of a-z, 0-9, _ or -). Fix the script and draft again.`);
  }
  const scenes: Record<string, unknown>[] = [];
  let startMs = 0;
  for (const [i, beat] of beats.entries()) {
    const fail = (errors: string[]) => new KnownFailure(`scenes_invalid: beat '${beat.id}' could not get a valid scene. Last problems: ${errors.slice(0, 5).join("; ")}`.slice(0, 600));
    const pick = await withRetries(ask, pickMessages(beat, kinds), (t) => checkPick(t, kinds));
    if ("errors" in pick) throw fail(pick.errors);
    const fill = await withRetries(ask, fillMessages(beat, pick.value, assets), (t) => {
      const r = check(t, pick.value, assets);
      return r.ok ? { ok: true, value: r.scene } : r;
    });
    if ("errors" in fill) throw fail(fill.errors);
    const durationMs = beatDurationMs(beat.text);
    scenes.push({ ...fill.value, id: `s${i + 1}`, beat: beat.id, startMs, durationMs });
    startMs += durationMs;
  }
  const doc = validateAndCheck({ version: 1, scenes }, { beats: beats.map((b) => b.id), assetIds: [...assets] });
  if (!doc.ok) throw new KnownFailure(`scenes_invalid: the assembled scenes do not fit. ${doc.errors.slice(0, 3).join("; ")}`.slice(0, 600));
  return doc.doc;
}
