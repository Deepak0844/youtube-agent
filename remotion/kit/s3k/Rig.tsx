// CameraRig: one smooth glide through your shot keys (a monotone spline: no overshoot, no stop-and-go between shots), framing boxes
// into the portrait safe area, never below the ground or water, with an optional lock on a moving hero.
import React, { useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FOV_DEG, resolveShots, rigPose, type HeroLock, type RigShot, type Safe } from "./framing";
import { useStable, useT } from "./time";

export type RigProps = {
  /** Camera keys in time order: `{ t, at, look }` (explicit) or `{ t, frame: { box, yawDeg, pitchDeg } }` (fit the box into the safe area). Needs 2+. */
  shots: readonly RigShot[];
  /** Eye must stay above this: a height, or a function of (x, z) for uneven ground. Include a margin (ground + 1.2). Default: no floor. */
  floor?: number | ((x: number, z: number) => number);
  /** Lean the look-at point towards a moving object for a while. */
  hero?: HeroLock;
  /** Safe area as fractions of the frame (default: portrait with a big top margin for the caption). */
  safe?: Safe;
  /** Vertical field of view in degrees (default 40). */
  fov?: number;
  /** Called once with each framed shot's coverage (to check a shot is not too empty or cut off). */
  onReport?: (r: { index: number; fill: number; fits: boolean }[]) => void;
};

export const CameraRig: React.FC<RigProps> = (props) => {
  const { shots, safe, fov = FOV_DEG } = useStable({ shots: props.shots, safe: props.safe, fov: props.fov });
  const { camera, size } = useThree();
  const t = useT();
  const aspect = size.width / size.height;
  const resolved = useMemo(() => resolveShots(shots, aspect, { safe, fovDeg: fov, minY: typeof props.floor === "number" ? props.floor : undefined }), [shots, aspect, safe, fov, props.floor]);
  const keys = useMemo(() => resolved.map((r) => r.key), [resolved]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => { props.onReport?.(resolved.map((r, index) => ({ index, fill: r.coverage?.fill ?? 0, fits: r.coverage?.fits ?? true }))); }, [resolved]);
  const pose = rigPose(keys, t, props.floor, props.hero);
  const cam = camera as THREE.PerspectiveCamera;
  cam.position.set(...pose.position);
  cam.lookAt(...pose.target);
  cam.fov = fov; cam.near = 1; cam.far = 3500; cam.aspect = aspect;
  cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  cam.userData.s3kTarget = new THREE.Vector3(...pose.target);
  return null;
};
