import { SCALE3D_LIMITS as L, scale3dSceneSchema, type Scale3dScene } from "./schema";

export type Scale3dResult = { ok: true; scene: Scale3dScene; totalS: number } | { ok: false; errors: string[] };

/** Checks a description the author wrote. Returns plain sentences an author (or a person) can act on. */
export function validateScale3d(input: unknown): Scale3dResult {
  const parsed = scale3dSceneSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "scene"}: ${i.message}`) };
  }
  const s = parsed.data;
  const errors: string[] = [];
  const byId = new Map(s.objects.map((o) => [o.id, o]));
  if (byId.size !== s.objects.length) errors.push("Two objects share the same id; every object needs its own id.");

  const carriedIds = new Set<string>();
  for (const o of s.objects) {
    if (!o.carries) continue;
    const load = byId.get(o.carries);
    if (o.kind !== "tower_crane") errors.push(`Object "${o.id}" carries something but is a ${o.kind}; only a tower_crane can hold a load.`);
    else if (!load) errors.push(`Object "${o.id}" carries "${o.carries}", which is not in the object list.`);
    else if (load.id === o.id) errors.push(`Object "${o.id}" cannot carry itself.`);
    else {
      if (load.carries) errors.push(`"${load.id}" is carried by "${o.id}" and cannot carry anything itself.`);
      if (load.height_m > o.height_m * 0.35) errors.push(`The load "${load.id}" (${load.height_m} m) is too big for "${o.id}" (${o.height_m} m); a load must be at most 35% of the crane's height.`);
      if (carriedIds.has(load.id)) errors.push(`"${load.id}" is carried by more than one crane.`);
      carriedIds.add(load.id);
    }
  }

  s.beats.forEach((b, i) => {
    const n = i + 1;
    const o = byId.get(b.focus);
    if (!o) return void errors.push(`Beat ${n} focuses on "${b.focus}", which is not in the object list.`);
    if (b.range_m) {
      const [lo, hi] = b.range_m;
      if (!(lo < hi)) errors.push(`Beat ${n}: range_m must go from a lower height to a higher one (got ${lo} to ${hi}).`);
      else if (hi > o.height_m * 1.02) errors.push(`Beat ${n}: range_m goes up to ${hi} m but "${o.id}" is only ${o.height_m} m tall.`);
    }
  });

  const totalS = Math.round(s.beats.reduce((a, b) => a + b.duration_s, 0) * 1000) / 1000;
  if (totalS < L.minTotalS || totalS > L.maxTotalS) errors.push(`The beats add up to ${totalS} s; the video must run ${L.minTotalS} to ${L.maxTotalS} s.`);

  return errors.length ? { ok: false, errors } : { ok: true, scene: s, totalS };
}
