// Pure parts of `npm run kit:preview`: no Docker, no files. Tested in tests/unit/kit-preview.test.ts.
import { validateScenes, type Scene } from "../src/shared/scene";
import { KIT_RENDERED_KINDS } from "../remotion/kit/rendered";

const FPS = 30; // keep equal to remotion/kit/theme.ts
export const RENDERABLE: readonly string[] = KIT_RENDERED_KINDS;

export function parseArgs(argv: string[]): { file: string } | { error: string } {
  const files = argv.filter((a) => a !== "--");
  if (files.length !== 1 || files[0]!.startsWith("-")) return { error: "usage: npm run kit:preview -- <scene.json>" };
  return { file: files[0]! };
}

export type Plan = { id: string; kind: Scene["kind"]; frames: number[]; scene: Scene };

/** Validate a scene file's text; on success, one plan per scene with frame 0 / middle / last. */
export function planPreview(text: string): { ok: true; plans: Plan[]; skipped: string[] } | { ok: false; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${(e as Error).message}`] };
  }
  const r = validateScenes(json);
  if (!r.ok) return r;
  const plans: Plan[] = [];
  const skipped: string[] = [];
  for (const scene of r.doc.scenes) {
    if (!RENDERABLE.includes(scene.kind)) {
      skipped.push(`${scene.id} (${scene.kind}) has no kit piece yet`);
      continue;
    }
    const last = Math.max(0, Math.round((scene.durationMs * FPS) / 1000) - 1);
    plans.push({ id: scene.id, kind: scene.kind, frames: [...new Set([0, Math.floor(last / 2), last])], scene });
  }
  return { ok: true, plans, skipped };
}
