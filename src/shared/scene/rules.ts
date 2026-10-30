// House rules checked after the schema passes. One table: add a rule = add one entry.
// Pure; src/shared must not import from remotion/kit at runtime, so the banned list is copied here (a test pins it to the theme).
import { LIMITS } from "./kinds/common";
import type { Scene, SceneDoc } from "./schema";
import { validateScenes } from "./validate";

export const BANNED_PHRASES = ["subscribe", "like and subscribe", "follow for more", "smash the like", "comment below", "link in bio"] as const;

export interface RuleOpts {
  /** Script beat ids in order; the first is the hook. */
  beats?: string[];
  maxScenesPerBeat?: number;
  /** Asset ids that exist for this video. When given, scenes may use only these. */
  assetIds?: string[];
  /** Run one rule only (tests). */
  only?: string;
}
type Problem = { scene?: number; text: string };
export interface Rule {
  code: string;
  fix: string;
  run: (scenes: Scene[], o: RuleOpts) => Problem[];
}

type Any = Record<string, unknown>;
const NOT_TEXT = new Set(["id", "kind", "beat", "asset", "image", "type", "from", "to", "enter", "media", "layout", "captionZone", "position", "url", "prompt", "notes", "ranges"]);

/** Every on-screen string in a scene (ids, enums and asset refs are not text). */
function texts(v: unknown, key = ""): string[] {
  if (typeof v === "string") return NOT_TEXT.has(key) ? [] : [v];
  if (Array.isArray(v)) return v.flatMap((x) => texts(x, key));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => texts(x, k));
  return [];
}
const arr = (s: Scene, k: string): unknown[] => ((s as unknown as Any)[k] as unknown[] | undefined) ?? [];
const assetsOf = (s: Scene): string[] => {
  const a = s as unknown as Any;
  return [a.asset, a.image, ...arr(s, "tiles").map((t) => (t as Any).asset), ...arr(s, "blocks").map((b) => (b as Any).asset)].filter((x): x is string => typeof x === "string");
};

// Frame 0 must show real content: per kind, what has to exist at the start.
const FRAME0: Record<string, (s: Scene) => boolean> = {
  terminal: (s) => typeof (arr(s, "lines")[0] as Any | undefined)?.text === "string" && ((arr(s, "lines")[0] as Any).text as string).trim() !== "",
  chat_thread: (s) => arr(s, "messages").length > 0,
  browser: (s) => arr(s, "blocks").length > 0,
};
const NEEDS_OBJECTS: Record<string, string> = { drawn_objects: "objects", network: "nodes" };
const NEEDS_ASSET = new Set(["stock_clip", "story_kenburns", "collage"]);

export const RULES: Rule[] = [
  {
    code: "hook-first",
    fix: "Make the first scene show the hook beat.",
    run: (sc, o) => (o.beats?.[0] && sc[0] && sc[0].beat !== o.beats[0] ? [{ scene: 0, text: `starts with beat '${sc[0].beat}', not the hook beat '${o.beats[0]}'` }] : []),
  },
  {
    code: "beat-order",
    fix: "Put scenes in script order and keep each beat's scenes together.",
    run: (sc, o) => {
      const order = o.beats;
      const out: Problem[] = [];
      let last = -1;
      const done = new Set<string>();
      sc.forEach((s, i) => {
        const at = order ? order.indexOf(s.beat) : -1;
        if (order && at < 0) out.push({ scene: i, text: `beat '${s.beat}' is not in the script` });
        else if (order && at < last) out.push({ scene: i, text: `beat '${s.beat}' comes after a later beat` });
        else if (!order && done.has(s.beat) && sc[i - 1]?.beat !== s.beat) out.push({ scene: i, text: `beat '${s.beat}' appears again after another beat` });
        if (at >= 0) last = Math.max(last, at);
        done.add(s.beat);
      });
      return out;
    },
  },
  {
    code: "beat-empty",
    fix: "Add at least one scene for every script beat.",
    run: (sc, o) => (o.beats ?? []).filter((b) => !sc.some((s) => s.beat === b)).map((b) => ({ text: `beat '${b}' has no scene` })),
  },
  {
    code: "beat-max-scenes",
    fix: "Merge scenes or drop extras so the beat stays short.",
    run: (sc, o) => {
      const max = o.maxScenesPerBeat;
      if (!max) return [];
      const n = new Map<string, number>();
      return sc.flatMap((s, i) => {
        n.set(s.beat, (n.get(s.beat) ?? 0) + 1);
        return n.get(s.beat) === max + 1 ? [{ scene: i, text: `beat '${s.beat}' has more than ${max} scenes` }] : [];
      });
    },
  },
  {
    code: "no-cta",
    fix: "Remove engagement-bait wording (subscribe, follow, comment, link in bio).",
    run: (sc) =>
      sc.flatMap((s, i) => {
        const low = texts(s).join("\n").toLowerCase();
        return BANNED_PHRASES.filter((p) => low.includes(p)).map((p) => ({ scene: i, text: `on-screen text has banned phrase "${p}"` }));
      }),
  },
  {
    code: "frame0",
    fix: "Start at 0 ms with the main content already showing, not an empty screen.",
    run: (sc) => {
      const s = sc[0];
      if (!s) return [];
      const out: Problem[] = [];
      if (s.startMs !== 0) out.push({ scene: 0, text: `first scene starts at ${s.startMs} ms, not 0` });
      if (FRAME0[s.kind] && !FRAME0[s.kind]!(s)) out.push({ scene: 0, text: `first scene (${s.kind}) is empty at the start` });
      return out;
    },
  },
  {
    code: "text-total",
    fix: "Cut words: keep one idea per scene.",
    run: (sc) =>
      sc.flatMap((s, i) => {
        const n = texts(s).reduce((a, t) => a + [...t].length, 0);
        return n > LIMITS.sceneTextTotal ? [{ scene: i, text: `${n} characters of on-screen text, over the ${LIMITS.sceneTextTotal} cap` }] : [];
      }),
  },
  {
    code: "local-assets",
    fix: "Use only asset ids from the asset list.",
    run: (sc, o) => {
      const ok = o.assetIds;
      return ok ? sc.flatMap((s, i) => assetsOf(s).filter((a) => !ok.includes(a)).map((a) => ({ scene: i, text: `unknown asset id '${a}'` }))) : [];
    },
  },
  {
    code: "has-objects",
    fix: "Add at least one real object or node; never text only.",
    run: (sc) => sc.flatMap((s, i) => (NEEDS_OBJECTS[s.kind] && arr(s, NEEDS_OBJECTS[s.kind]!).length === 0 ? [{ scene: i, text: `${s.kind} has no ${NEEDS_OBJECTS[s.kind]}` }] : [])),
  },
  {
    code: "has-asset",
    fix: "Reference an asset id from the asset list.",
    run: (sc) => sc.flatMap((s, i) => (NEEDS_ASSET.has(s.kind) && assetsOf(s).length === 0 ? [{ scene: i, text: `${s.kind} has no asset` }] : [])),
  },
];

/** Plain-text problems, same style as validateScenes errors, ready for a retry prompt. */
export function checkSceneRules(doc: SceneDoc, opts: RuleOpts = {}): string[] {
  return RULES.filter((r) => !opts.only || r.code === opts.only).flatMap((r) =>
    r.run(doc.scenes, opts).map((p) => `${p.scene === undefined ? "document" : `scene ${p.scene + 1}`}: ${p.text} [${r.code}]. Fix: ${r.fix}`),
  );
}

export type CheckResult = { ok: true; doc: SceneDoc } | { ok: false; errors: string[] };

/** Schema first; only a schema-valid doc gets the house rules. */
export function validateAndCheck(input: unknown, opts: RuleOpts = {}): CheckResult {
  const r = validateScenes(input);
  if (!r.ok) return r;
  const errors = checkSceneRules(r.doc, opts);
  return errors.length ? { ok: false, errors } : { ok: true, doc: r.doc };
}
