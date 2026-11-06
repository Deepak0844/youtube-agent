// EXAMPLE B (no models): a tower rises row by row from a plaza, with dust. COPY: three.js geometry only from the allowed list, one InstancedMesh
// for hundreds of bricks (one draw call), particles with makeParticles, seeded randomness (rnd), a loop with a constant bound, a camera glide.
import React, { useMemo } from "react";
import * as THREE from "three";
import { CameraRig, Finish, Hero, World, glideTimes, instance, lerp, makeParticles, placeSlots, ramp, rnd, smooth, std, useT } from "s3k";
import type { SceneProps } from "s3k";

const ROWS = 24, PER_ROW = 8, BRICK = { w: 1.2, h: 0.6, d: 1.2 };
const FOCUS = { min: [-14, 0, -14] as [number, number, number], max: [14, 18, 14] as [number, number, number] };

export default function Scene({ durationS }: SceneProps) {
  const t = useT();
  const parts = useMemo(() => {
    const random = rnd(7);
    const slots = [] as { x: number; y: number; z: number; ry: number }[];
    for (let r = 0; r < ROWS; r++) {
      for (let k = 0; k < PER_ROW; k++) {
        const a = (k / PER_ROW) * Math.PI * 2 + (r % 2) * 0.2;
        slots.push({ x: Math.cos(a) * 3.4, y: BRICK.h / 2 + r * BRICK.h, z: Math.sin(a) * 3.4, ry: -a + (random() - 0.5) * 0.04 });
      }
    }
    const mat = std("#c9a27a", { roughness: 0.8 });
    const bricks = instance(new THREE.BoxGeometry(BRICK.w, BRICK.h, BRICK.d), mat, slots, { tint: (i) => (i % 3 === 0 ? "#b98a62" : "#d8b48c") });
    const dust = makeParticles({ count: 220, seed: 3, size: 1.4, emit: (s, ph, time, out) => { out[0] = Math.cos(s.a) * (3 + s.r * 3); out[1] = 0.3 + ph * 6; out[2] = Math.sin(s.a) * (3 + s.r * 3); } });
    return { slots, bricks, dust };
  }, []);
  // Rows appear one by one: row r is built between 10% and 85% of the film.
  const built = ramp(t, 0.1 * durationS, 0.85 * durationS) * ROWS;
  const shown = parts.slots.map((s) => ({ ...s, s: smooth(Math.min(1, Math.max(0, built - s.y / BRICK.h + 0.5))) })).map((s) => ({ ...s, y: lerp(s.y - 1, s.y, s.s), s: Math.max(0.001, s.s) }));
  placeSlots(parts.bricks, shown);
  parts.dust.update(t);
  const shots = useMemo(() => {
    const [t0 = 0, t1 = 1, t2 = 2] = glideTimes(3, durationS);
    return [
      { t: t0, frame: { box: { min: [-5, 0, -5] as [number, number, number], max: [5, 4, 5] as [number, number, number] }, yawDeg: 30, pitchDeg: 16 } },
      { t: t1, frame: { box: { min: [-5, 0, -5] as [number, number, number], max: [5, 10, 5] as [number, number, number] }, yawDeg: -20, pitchDeg: 12 } },
      { t: t2, frame: { box: { min: [-5, 0, -5] as [number, number, number], max: [5, 15, 5] as [number, number, number] }, yawDeg: 10, pitchDeg: 8 } },
    ];
  }, [durationS]);
  return (
    <>
      <World focus={FOCUS} preset="haze" ground={{ y: 0, kind: "pave" }} sea={false} />
      <Hero><primitive object={parts.bricks} /></Hero>
      <primitive object={parts.dust.points} />
      <CameraRig shots={shots} floor={1.5} />
      <Finish />
    </>
  );
}
