import { z } from "zod";
import { kinds } from "./kinds";
import { LIMITS, SCENE_SCHEMA_VERSION, sceneDocSchema, type SceneDoc } from "./schema";

export type ValidateResult = { ok: true; doc: SceneDoc } | { ok: false; errors: string[] };

const KINDS = Object.keys(kinds);

function where(path: PropertyKey[]): string {
  if (path[0] === "scenes" && typeof path[1] === "number") {
    return [`scene ${path[1] + 1}`, ...path.slice(2).map(String)].join(" > ");
  }
  return path.map(String).join(" > ") || "document";
}

/** Plain-text errors, one per line, ready to paste into a retry prompt. */
export function validateScenes(input: unknown): ValidateResult {
  const r = sceneDocSchema.safeParse(input);
  if (r.success) return { ok: true, doc: r.data };
  const errors = r.error.issues.map((i) => {
    if (i.code === "invalid_union") return `${where(i.path)}: must be one of ${KINDS.join(", ")}`;
    return `${where(i.path)}: ${i.message}`;
  });
  return { ok: false, errors };
}

/** JSON Schema for structured-output / prompt use. */
export function sceneJsonSchema(): object {
  return z.toJSONSchema(sceneDocSchema, { io: "input", unrepresentable: "any" });
}

/** Kinds that point at library images/clips. Offered to a model only when the video has some. */
export const ASSET_KINDS: readonly string[] = ["collage", "stock_clip", "story_kenburns"];

/** Kinds a model may use: all of them with assets, else only those that need none. */
export function usableKinds(hasAssets: boolean): string[] {
  return KINDS.filter((k) => hasAssets || !ASSET_KINDS.includes(k));
}

/** Short human text for a prompt: what to fill and the hard limits. `only` limits the kind list (see usableKinds). */
export function describeSceneFormat(only?: readonly string[]): string {
  return [
    `Return JSON: {"version": ${SCENE_SCHEMA_VERSION}, "scenes": [...]}. Portrait video. Times are whole milliseconds.`,
    `Every scene: id, kind, beat (script beat id), startMs, durationMs (${LIMITS.minSceneMs}-${LIMITS.maxSceneMs}). Scenes must not overlap; total at most ${LIMITS.maxTotalMs} ms.`,
    ...Object.entries(kinds).filter(([n]) => !only || only.includes(n)).map(([, k]) => k.describe),
    `Never use URLs or file paths; refer to media by asset id only.`,
  ].join("\n");
}

/** One short line per kind (name plus the start of its description), for a cheap "which kind fits this beat" prompt. */
export function kindBlurbs(only: readonly string[]): string {
  return Object.entries(kinds)
    .filter(([n]) => only.includes(n))
    .map(([n, k]) => `- ${n}: ${k.describe.replace(/^kind "[^"]*":\s*/, "").slice(0, 70)}`)
    .join("\n");
}
