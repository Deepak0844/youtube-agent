import type { Message } from "@/server/core/agent-loop";
import { assetRefs, parseJson, withRetries, type AskScene } from "@/server/core/scene-build";
import { describeSceneFormat, validateScenes } from "@/shared/scene";
import { validateAndCheck } from "@/shared/scene/rules";

// Repair: ask the model to fix ONLY the scenes that fail the checks. The app keeps id, beat and timing and every other
// scene byte for byte. Same retry rule as Build (max 2, the same errors twice stop). No partial result: the caller only
// saves a document that passes every check.

export interface RepairOpts {
  beats?: string[];
  assets: string[];
}
export type SceneBody = { version: number; scenes: Record<string, unknown>[] };
export type RepairResult = { ok: true; body: SceneBody; changed: string[] } | { ok: false; errors: string[] };

/** Zero-based scene numbers named by the plain-text problems, and whether any problem names no scene (document level). */
export function failingScenes(errors: readonly string[]): { indexes: number[]; documentLevel: boolean } {
  const idx = new Set<number>();
  let documentLevel = false;
  for (const e of errors) {
    const m = /^scene (\d+)\b/.exec(e);
    if (m) idx.add(Number(m[1]) - 1);
    else documentLevel = true;
  }
  return { indexes: [...idx].sort((a, b) => a - b), documentLevel };
}

function fixMessages(scene: Record<string, unknown>, problems: string[], assets: readonly string[]): Message[] {
  const kind = String(scene.kind);
  return [
    {
      role: "system",
      content: [
        "You fix ONE scene of JSON for a short portrait video. Keep what works; change only what the problems name.",
        describeSceneFormat([kind]),
        assets.length > 0 ? `Allowed asset ids (use only these): ${assets.join(", ")}.` : "No images or clips exist for this video: do not use asset ids.",
        `Reply with only JSON: {"version": 1, "scenes": [the ONE corrected scene]}. Keep id "${scene.id}", beat "${scene.beat}", startMs ${scene.startMs} and durationMs ${scene.durationMs} as they are.`,
      ].join("\n\n"),
    },
    { role: "user", content: `The scene:\n${JSON.stringify(scene)}\n\nProblems:\n${problems.join("\n")}` },
  ];
}

/** Repairs the scenes at `targets` (zero-based) of the stored body. Scenes not in `targets` are returned exactly as stored. */
export async function repairSceneDoc(body: SceneBody, targets: readonly number[], problems: readonly string[], ask: AskScene, o: RepairOpts): Promise<RepairResult> {
  const scenes = [...body.scenes];
  const changed: string[] = [];
  for (const i of targets) {
    const orig = scenes[i];
    if (!orig) return { ok: false, errors: [`scene ${i + 1} does not exist`] };
    const mine = problems.filter((p) => p.startsWith(`scene ${i + 1}:`) || p.startsWith(`scene ${i + 1} `));
    const res = await withRetries<Record<string, unknown>>(ask, fixMessages(orig, mine, o.assets), (text) => {
      const raw = parseJson(text);
      if (raw === undefined) return { ok: false, errors: ["The answer was not valid JSON."] };
      const r = validateScenes(raw);
      if (!r.ok) return { ok: false, errors: r.errors };
      if (r.doc.scenes.length !== 1) return { ok: false, errors: [`must have exactly 1 scene, got ${r.doc.scenes.length}`] };
      const fixed = { ...(r.doc.scenes[0] as unknown as Record<string, unknown>), id: orig.id, beat: orig.beat, startMs: orig.startMs, durationMs: orig.durationMs };
      const bad = [...new Set(assetRefs(fixed).filter((a) => !o.assets.includes(a)))];
      if (bad.length > 0) return { ok: false, errors: [`asset id ${bad.join(", ")} does not exist for this video`] };
      // Judge the scene inside the whole document, but only its own problems count here (others are fixed in their own turn).
      const probe = scenes.map((s, j) => (j === i ? fixed : s));
      const c = validateAndCheck({ version: body.version, scenes: probe }, { beats: o.beats, assetIds: o.assets });
      const own = c.ok ? [] : c.errors.filter((e) => e.startsWith(`scene ${i + 1}:`) || e.startsWith(`scene ${i + 1} `));
      return own.length ? { ok: false, errors: own } : { ok: true, value: fixed };
    });
    if ("errors" in res) return { ok: false, errors: res.errors.slice(0, 5) };
    scenes[i] = res.value;
    changed.push(String(orig.id));
  }
  const final = validateAndCheck({ version: body.version, scenes }, { beats: o.beats, assetIds: o.assets });
  return final.ok ? { ok: true, body: { ...body, scenes }, changed } : { ok: false, errors: final.errors.slice(0, 5) };
}
