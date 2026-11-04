import { SCENE3D_LIMITS as L, scene3dSchema, type Scene3d } from "./schema";
import { type ModelResolver } from "./resolver";

export type Scene3dResult = { ok: true; scene: Scene3d; totalS: number; warnings: string[] } | { ok: false; errors: string[] };

export const shotsTotalS = (shots: readonly { duration_s: number }[]): number => Math.round(shots.reduce((a, s) => a + s.duration_s, 0) * 1000) / 1000;

/** Checks a scene the director wrote. Returns plain sentences a person can act on. Pass a resolver to check model references too. */
export function validateScene3d(input: unknown, resolver?: ModelResolver): Scene3dResult {
  const parsed = scene3dSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "scene"}: ${i.message}`) };
  const s = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const e of s.elements) {
    if (ids.has(e.id)) errors.push(`Two elements share the id "${e.id}"; every element needs its own id.`);
    ids.add(e.id);
  }
  const totalS = shotsTotalS(s.shots);
  if (totalS > L.maxTotalS) errors.push(`The shots add up to ${totalS} s; the video can run at most ${L.maxTotalS} s.`);
  if (totalS < L.minTotalS) errors.push(`The shots add up to ${totalS} s; the video must run at least ${L.minTotalS} s.`);

  const shotIds = new Set<string>();
  s.shots.forEach((sh, i) => {
    const n = i + 1;
    if (shotIds.has(sh.id)) errors.push(`Two shots share the id "${sh.id}".`);
    shotIds.add(sh.id);
    if (!sh.focus && !sh.free) errors.push(`Shot ${n} has neither a focus element nor a free camera; give it one of them.`);
    if (sh.focus && sh.free) errors.push(`Shot ${n} has both a focus and a free camera; use only one.`);
    for (const f of sh.focus === undefined ? [] : Array.isArray(sh.focus) ? sh.focus : [sh.focus]) {
      if (!ids.has(f)) errors.push(`Shot ${n} focuses on "${f}", which is not in the element list.`);
    }
    if (sh.free && sh.free.position.every((v, k) => v === sh.free!.target[k])) errors.push(`Shot ${n}: the free camera position and target are the same point.`);
  });

  for (const e of s.elements) {
    if (e.kind === "skyline" && e.min_height_m > e.max_height_m) errors.push(`Element "${e.id}": min_height_m (${e.min_height_m}) is above max_height_m (${e.max_height_m}).`);
    if (e.kind === "rock_pile" && e.shape === "ring" && e.radius_m < e.width_m) errors.push(`Element "${e.id}": a ring's width_m (${e.width_m}) cannot be bigger than its radius_m (${e.radius_m}).`);
    if (e.kind === "arrow" && e.at.x === e.to[0] && e.at.z === e.to[2] && (e.at.y ?? 0) === e.to[1]) errors.push(`Element "${e.id}": the arrow starts and ends at the same point.`);
    if (e.kind === "model" && resolver && !resolver.resolve(e.model)) {
      errors.push(`Element "${e.id}": the model ${"catalog" in e.model ? `"${e.model.catalog}" is not in the catalogue` : `file "${e.model.file}" is not allowed (use a .glb under assets3d/files/)`}.`);
    }
    e.animations.forEach((a, k) => {
      const where = `Element "${e.id}" animation ${k + 1}`;
      if (a.start_s + a.duration_s > totalS + 0.01) errors.push(`${where} runs until ${Math.round((a.start_s + a.duration_s) * 100) / 100} s, after the video ends at ${totalS} s.`);
      if (a.type === "pour" && e.kind !== "sand_pile") errors.push(`${where}: only a sand_pile can be built by a pour (this is a ${e.kind}).`);
      if (a.type === "move_along_path" && e.kind === "water") errors.push(`${where}: water cannot move along a path.`);
    });
    if (e.animations.filter((a) => a.type === "move_along_path").length > 1) errors.push(`Element "${e.id}" has more than one move_along_path; use one path with several points.`);
  }
  if (s.elements.filter((e) => e.kind === "water").length > 1) warnings.push("More than one water element: only the first one gets caustics and foam.");
  return errors.length ? { ok: false, errors } : { ok: true, scene: s, totalS, warnings };
}
