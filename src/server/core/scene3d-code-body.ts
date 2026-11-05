import { z } from "zod";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { SCENE_MAX_BYTES } from "@/server/core/scene3d-code-check";

// What the author step stores (content kind `scenes`, body kind "scene3d_code") and what Render and the preview pictures read back.
// The source text and the host-built props are the whole input of the render, so ONE fingerprint over both is what the owner approves.

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const finite = z.number().finite();
export const scenePropsSchema = z.object({
  beats: z.array(z.object({ id: z.string().min(1).max(40), text: z.string().max(400), from: finite.min(0).max(200), to: finite.min(0).max(200) })).min(1).max(30),
  captions: z.array(z.object({ from: finite.min(0).max(200), to: finite.min(0).max(200), text: z.string().min(1).max(40) })).max(30),
  durationS: finite.min(0.1).max(75),
});
export type SceneProps = z.infer<typeof scenePropsSchema>;

export const scene3dCodeBodySchema = z.object({
  kind: z.literal("scene3d_code"),
  source: z.string().min(1).max(SCENE_MAX_BYTES),
  source_sha256: hex64,
  /** Catalogue model ids the scene names (for the Look card and for staging). */
  models: z.array(z.string().max(80)).max(60),
  props: scenePropsSchema,
  attempts: z.number().int().min(1).max(10),
});
export type Scene3dCodeBody = z.infer<typeof scene3dCodeBodySchema>;

/** The fingerprint of what is rendered: the exact source plus the exact props. The Look gate and Render compare it. */
export const sceneCodeSha = (source: string, props: SceneProps): string => sha256Hex(canonicalJson({ source_sha256: sha256Hex(source), props }));

/** The stored body, or null when it is not a valid scene3d_code body (or its fingerprint of the source does not match the source). */
export function readSceneCodeBody(body: unknown): Scene3dCodeBody | null {
  const r = scene3dCodeBodySchema.safeParse(body);
  return r.success && sha256Hex(r.data.source) === r.data.source_sha256 ? r.data : null;
}
