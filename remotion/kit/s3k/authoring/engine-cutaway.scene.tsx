// EXAMPLE C (a machine, "how it works"): a lengthwise CUTAWAY of an engine. The casing is a half pipe, so you look inside and see four
// separate STAGES in a row (fan, compressor, combustor, turbine), air particles that flow through them and change colour, and a camera that
// follows the process stage by stage. COPY: a half-open casing (CylinderGeometry thetaLength), one InstancedMesh of blades per stage,
// stage lights and glow materials, particles with makeParticles, a camera shot per stage from glideTimes, spinning blades from t.
import React, { useMemo } from "react";
import * as THREE from "three";
import { CameraRig, Finish, Hero, World, glideTimes, glow, instance, makeParticles, placeSlots, std, useT } from "s3k";
import type { SceneProps } from "s3k";

const LEN = 12, R = 2.2, CENTRE_Y = 2.6; // engine runs along x from -6 to 6, resting on a stand
const STAGE_X = [-4.5, -1.5, 1.5, 4.5]; // fan, compressor, combustor, turbine
const FOCUS = { min: [-8, 0, -4] as [number, number, number], max: [8, 6, 4] as [number, number, number] };
type Slot = { x: number; y: number; z: number; rx?: number; ry?: number; rz?: number };

export default function Scene({ durationS }: SceneProps) {
  const t = useT();
  const parts = useMemo(() => {
    // The casing: a half pipe (open towards the viewer, +z) so the inside is visible. thetaLength = half a circle.
    const casing = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, LEN, 48, 1, true, Math.PI, Math.PI),
      std("#8f98a3", { roughness: 0.45, metalness: 0.7, side: THREE.DoubleSide }),
    );
    casing.rotation.z = Math.PI / 2;
    casing.position.set(0, CENTRE_Y, 0);
    // Four glowing stage rings so each stage is clearly separate and has its own colour.
    const ringColours = ["#7fd1ff", "#5aa8ff", "#ff9a3c", "#ff5a2a"];
    const rings: THREE.Mesh[] = [];
    for (let k = 0; k < 4; k++) {
      const m = new THREE.Mesh(new THREE.TorusGeometry(R * 0.98, 0.06, 12, 48, Math.PI), glow(ringColours[k] ?? "#ffffff", 1.4));
      m.rotation.y = Math.PI / 2;
      m.position.set((STAGE_X[k] ?? 0) - 1.2, CENTRE_Y, 0);
      rings.push(m);
    }
    // The centre shaft that all blades sit on.
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, LEN - 0.6, 20), std("#b9c0c8", { roughness: 0.3, metalness: 0.9 }));
    shaft.rotation.z = Math.PI / 2;
    shaft.position.set(0, CENTRE_Y, 0);
    // One InstancedMesh of blades per stage (a ring of 14 flat blades each). Each stage has its own size and colour.
    const BLADES = 14;
    const bladeGeo = new THREE.BoxGeometry(0.08, 1, 0.34);
    const makeBlades = (x: number, len: number, colour: string) => {
      const slots: Slot[] = [];
      for (let i = 0; i < BLADES; i++) {
        const a = (i / BLADES) * Math.PI * 2;
        slots.push({ x, y: CENTRE_Y + Math.cos(a) * len * 0.5, z: Math.sin(a) * len * 0.5, rx: a });
      }
      return { slots, mesh: instance(bladeGeo, std(colour, { roughness: 0.35, metalness: 0.8 }), slots), x, len };
    };
    const stages = [makeBlades(STAGE_X[0] ?? 0, 2.0, "#cfe9ff"), makeBlades(STAGE_X[1] ?? 0, 1.6, "#9cc4ee"), makeBlades(STAGE_X[2] ?? 0, 1.0, "#ffb36b"), makeBlades(STAGE_X[3] ?? 0, 1.5, "#e6552b")];
    // Air: particles enter at the left, are squeezed through the stages and leave hot at the right. Colour changes by stage via position.
    const air = makeParticles({
      count: 700, seed: 5, size: 0.22, color: "#bfe6ff", opacity: 0.9,
      emit: (s, ph, time, out) => {
        const x = -LEN / 2 + ph * LEN;
        const squeeze = 1 - 0.55 * Math.min(1, Math.max(0, (x + 4) / 5)); // the channel narrows towards the combustor
        const swirl = s.a + time * 3 + ph * 8;
        out[0] = x;
        out[1] = CENTRE_Y + Math.cos(swirl) * R * 0.7 * squeeze * s.r;
        out[2] = Math.sin(swirl) * R * 0.7 * squeeze * s.r;
      },
    });
    // The fire: bright particles inside the combustor (stage 3) only.
    const fire = makeParticles({
      count: 260, seed: 9, size: 0.45, color: "#ff7a1a", opacity: 1,
      emit: (s, ph, time, out) => {
        out[0] = STAGE_X[2]! - 1.1 + ph * 2.4;
        out[1] = CENTRE_Y + (s.v - 0.5) * 0.6 + Math.cos(s.a + time * 5) * 0.5 * s.r;
        out[2] = Math.sin(s.a + time * 5) * 0.5 * s.r;
      },
    });
    // The stand under the engine so nothing floats.
    const stand = new THREE.Mesh(new THREE.BoxGeometry(LEN - 2, 0.5, 1.2), std("#3b4048", { roughness: 0.8 }));
    stand.position.set(0, 0.25, 0);
    return { casing, rings, shaft, stages, air, fire, stand };
  }, []);
  // Every blade ring spins; the fan and compressor spin one way, the turbine the other, all as a pure function of t.
  parts.stages.forEach((st, k) => {
    const spin = t * (k === 3 ? -9 : 7);
    const slots = st.slots.map((s, i) => {
      const a = (i / st.slots.length) * Math.PI * 2 + spin;
      return { ...s, y: CENTRE_Y + Math.cos(a) * st.len * 0.5, z: Math.sin(a) * st.len * 0.5, rx: a };
    });
    placeSlots(st.mesh, slots);
  });
  parts.air.update(t);
  parts.fire.update(t);
  // One camera shot per stage, in order: the whole engine, then fan, compressor, combustor, turbine. The camera glides along the engine.
  const shots = useMemo(() => {
    const times = glideTimes(5, durationS);
    const box = (x0: number, x1: number) => ({ min: [x0, 0.8, -2.2] as [number, number, number], max: [x1, 4.6, 2.2] as [number, number, number] });
    return [
      { t: times[0] ?? 0, frame: { box: box(-6, 6), yawDeg: 20, pitchDeg: 14 } },
      { t: times[1] ?? 1, frame: { box: box(-6, -3), yawDeg: 28, pitchDeg: 10 } },
      { t: times[2] ?? 2, frame: { box: box(-3, 0), yawDeg: 22, pitchDeg: 10 } },
      { t: times[3] ?? 3, frame: { box: box(0, 3), yawDeg: 16, pitchDeg: 10 } },
      { t: times[4] ?? 4, frame: { box: box(3, 6), yawDeg: 10, pitchDeg: 10 } },
    ];
  }, [durationS]);
  return (
    <>
      <World focus={FOCUS} preset="clear" ground={{ y: 0, kind: "pave" }} sea={false} />
      <Hero>
        <group>
          <primitive object={parts.casing} />
          <primitive object={parts.shaft} />
          {parts.rings.map((r, i) => (
            <primitive key={i} object={r} />
          ))}
          {parts.stages.map((s, i) => (
            <primitive key={i} object={s.mesh} />
          ))}
        </group>
      </Hero>
      <primitive object={parts.stand} />
      <primitive object={parts.air.points} />
      <primitive object={parts.fire.points} />
      <CameraRig shots={shots} floor={0.8} />
      <Finish />
    </>
  );
}
