// Reads the zod schemas of scene format v2 so the director prompt, the key cleaning and the error sentences all come from ONE source
// (schema.ts) and cannot drift from the validator. Reads zod's own definition objects; pure, no app imports.
import { scene3dSchema } from "./schema";

type Def = { type: string; shape?: Record<string, unknown>; element?: unknown; innerType?: unknown; options?: unknown[]; discriminator?: string; values?: unknown[] };
const def = (s: unknown): Def => (s as { _zod: { def: Def } })._zod.def;
const WRAPPERS = new Set(["default", "optional", "nullable", "readonly"]);
function unwrap(s: unknown): unknown {
  let cur = s;
  while (WRAPPERS.has(def(cur).type) && def(cur).innerType) cur = def(cur).innerType;
  return cur;
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A key is only printed when it looks like a short identifier; anything else (a long invented key) is called "a long key". */
export const SAFE_KEY = /^[a-z_][a-z0-9_]{0,31}$/;
export const keyWord = (k: string): string => (SAFE_KEY.test(k) ? `"${k}"` : "a long key");

/** The option of a discriminated union that matches this value, or undefined. */
function pickOption(d: Def, value: unknown): unknown {
  if (!d.discriminator || !isObj(value)) return undefined;
  return d.options?.find((o) => def(def(o).shape?.[d.discriminator!]).values?.includes(value[d.discriminator!]));
}

/** The object schema that governs `value` at `path` (an array of keys and indexes from the root), or undefined. */
export function schemaAt(schema: unknown, value: unknown, path: ReadonlyArray<string | number>): unknown {
  let s = unwrap(schema);
  let v = value;
  for (const seg of path) {
    let d = def(s);
    if (d.type === "union") {
      const o = pickOption(d, v);
      if (!o) return undefined;
      s = o;
      d = def(s);
    }
    if (d.type === "array" && typeof seg === "number") s = unwrap(d.element);
    else if (d.type === "object" && typeof seg === "string" && d.shape?.[seg]) s = unwrap(d.shape[seg]);
    else return undefined;
    v = isObj(v) ? v[seg as string] : Array.isArray(v) ? v[seg as number] : undefined;
  }
  const d = def(s);
  return d.type === "union" ? pickOption(d, v) : s;
}

/** The keys an object schema allows (empty when the schema at that place is not an object). */
export function allowedKeys(schema: unknown): string[] {
  const d = schema ? def(schema) : undefined;
  return d?.type === "object" && d.shape ? Object.keys(d.shape) : [];
}

/** Copy of `value` without the keys the schema does not know (at every object level it can follow); a warning for each. */
export function stripUnknownKeys(schema: unknown, value: unknown, where: string, warnings: string[]): unknown {
  const s = unwrap(schema);
  const d = def(s);
  if (d.type === "array" && Array.isArray(value)) return value.map((x, i) => stripUnknownKeys(d.element, x, `${where}.${i}`, warnings));
  let target = s;
  if (d.type === "union") {
    const o = pickOption(d, value);
    if (!o) return value;
    target = o;
  }
  const td = def(target);
  if (td.type !== "object" || !td.shape || !isObj(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k in td.shape) out[k] = stripUnknownKeys(td.shape[k], v, where ? `${where}.${k}` : k, warnings);
    else warnings.push(`dropped the unknown key ${keyWord(k)} at ${where || "scene"}`);
  }
  return out;
}

/** Every key the scene format accepts, per object kind, for the director prompt: "box: id, at, animations, kind, size_m, material". */
export function schemaKeyLines(): string[] {
  const root = def(scene3dSchema).shape!;
  const lines: string[] = [`scene: ${Object.keys(root).join(", ")}`];
  const worldDef = def(unwrap(root.world));
  lines.push(`world: ${Object.keys(worldDef.shape!).join(", ")}`);
  for (const k of ["sun", "ground", "fog"]) lines.push(`world.${k}: ${allowedKeys(unwrap(worldDef.shape![k])).join(", ")}`);
  const els = def(unwrap(root.elements)).element;
  const elementUnion = def(unwrap(els));
  const first = def(elementUnion.options![0]).shape!;
  lines.push(`at (placement of any element): ${allowedKeys(unwrap(first.at)).join(", ")}`);
  for (const o of elementUnion.options!) lines.push(`element ${String(def(def(o).shape!.kind).values![0])}: ${allowedKeys(o).join(", ")}`);
  const anims = def(unwrap(first.animations)).element;
  for (const o of def(unwrap(anims)).options!) lines.push(`animation ${String(def(def(o).shape!.type).values![0])}: ${allowedKeys(o).join(", ")}`);
  lines.push(`shot: ${allowedKeys(unwrap(def(unwrap(root.shots)).element)).join(", ")}`);
  return lines;
}

/** Every distinct key name anywhere in the scene format (for tests: all of them must be in the prompt). */
export function allSchemaKeys(): string[] {
  const keys = new Set<string>();
  for (const l of schemaKeyLines()) for (const k of l.slice(l.indexOf(":") + 1).split(",")) if (k.trim()) keys.add(k.trim());
  return [...keys];
}
