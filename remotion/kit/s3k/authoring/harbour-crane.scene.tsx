// EXAMPLE A (catalogue models): a crane lifts a container onto a ship. COPY: a world that reaches the horizon (quay + sea), models through
// useModels, every object placed with rest(), motion as a pure function of t, a camera glide through three framed shots.
import React, { useMemo } from "react";
import { CameraRig, Finish, Hero, World, glideTimes, lerp, ramp, rest, shadowize, smooth, useModels, useT } from "s3k";
import type { SceneProps } from "s3k";

const CRANE = "pp_crane_17ab", BOX = "pp_shipping_container_dqxr", SHIP = "pp_sail_ship_cizo";
const FOCUS = { min: [-30, -3, -34] as [number, number, number], max: [30, 28, 12] as [number, number, number] };
const SEA_Y = -1.2;

export default function Scene({ resolver, durationS }: SceneProps) {
  const models = useModels([CRANE, BOX, SHIP], resolver);
  const t = useT();
  const parts = useMemo(() => {
    if (!models) return null;
    const crane = shadowize(models.get(CRANE, { size: 26 }));
    crane.position.set(-6, 0, -2);
    const ship = shadowize(models.get(SHIP, { size: 34 }));
    ship.position.set(8, 0, -16);
    ship.rotation.y = Math.PI / 2;
    rest(ship, SEA_Y + 0.4);
    const box = shadowize(models.get(BOX, { size: 8 }));
    return { crane, ship, box };
  }, [models]);
  const shots = useMemo(() => {
    const [t0 = 0, t1 = 1, t2 = 2] = glideTimes(3, durationS);
    return [
      { t: t0, frame: { box: { min: [-14, 0, -6] as [number, number, number], max: [4, 26, 6] as [number, number, number] }, yawDeg: 24, pitchDeg: 10 } },
      { t: t1, frame: { box: { min: [-14, 0, -20] as [number, number, number], max: [18, 16, 6] as [number, number, number] }, yawDeg: -18, pitchDeg: 14 } },
      { t: t2, frame: { box: { min: [-2, -2, -22] as [number, number, number], max: [20, 14, -10] as [number, number, number] }, yawDeg: 12, pitchDeg: 18 } },
    ];
  }, [durationS]);
  if (!parts) return null;
  // The container travels from the quay (x -6, z 3) up, across and down onto the ship deck (x 8, z -16).
  const up = smooth(ramp(t, 0.15 * durationS, 0.4 * durationS)), over = smooth(ramp(t, 0.4 * durationS, 0.7 * durationS)), down = smooth(ramp(t, 0.7 * durationS, 0.92 * durationS));
  parts.box.position.set(lerp(-6, 8, over), lerp(0.2, 9, up) - 5.5 * down, lerp(3, -16, over));
  return (
    <>
      <World focus={FOCUS} preset="clear" ground={{ y: 0, kind: "pave", zMin: -4 }} sea={{ y: SEA_Y, zMax: -4 }} />
      <Hero><primitive object={parts.crane} /></Hero>
      <primitive object={parts.ship} />
      <primitive object={parts.box} />
      <CameraRig shots={shots} floor={2} />
      <Finish />
    </>
  );
}
