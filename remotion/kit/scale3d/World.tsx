import React, { useLayoutEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FOV_DEG, cameraPosition, type CamPose, type Placement } from "../../../src/shared/scale3d/math";
import type { Scale3dScene } from "../../../src/shared/scale3d";
import { Clouds, Ground, PlacedModel } from "./models";

export const HORIZON = "#dcebf4";

/** Camera + sun that follow the pose. The sun's shadow box is re-fitted to the shot each frame, so shadows stay sharp at every scale. */
const Rig: React.FC<{ pose: CamPose }> = ({ pose }) => {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const sun = useRef<THREE.DirectionalLight>(null);
  useLayoutEffect(() => {
    const pos = cameraPosition(pose);
    camera.fov = FOV_DEG;
    camera.near = Math.max(0.1, pose.dist * 0.02);
    camera.far = pose.dist * 80;
    camera.position.set(pos.x, pos.y, pos.z);
    camera.lookAt(pose.x, pose.y, pose.z);
    camera.updateProjectionMatrix();
    const l = sun.current;
    if (l) {
      const reach = pose.dist * 0.9;
      l.target.position.set(pose.x, pose.y * 0.6, pose.z);
      l.target.updateMatrixWorld();
      l.position.set(pose.x + reach * 0.9, pose.y * 0.6 + reach * 1.6, pose.z + reach * 1.1);
      const e = pose.dist * 0.95;
      const sc = l.shadow.camera;
      sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e;
      sc.near = reach * 0.2;
      sc.far = reach * 6;
      sc.updateProjectionMatrix();
    }
  });
  return (
    <>
      <fog attach="fog" args={[HORIZON, pose.dist * 2.5, pose.dist * 40]} />
      <hemisphereLight args={["#e4f2ff", "#efe3cc", 1.15]} />
      <directionalLight ref={sun} intensity={2.1} color="#fff0d8" castShadow shadow-mapSize={[2048, 2048]} shadow-radius={6} shadow-bias={-0.0003} shadow-normalBias={0.05} />
    </>
  );
};

/** Everything in the 3D canvas: lights, ground, sky objects and the placed models. */
export const World: React.FC<{ scene: Scale3dScene; placements: Placement[]; pose: CamPose }> = ({ scene, placements, pose }) => {
  const reach = Math.max(300, ...placements.map((p) => Math.abs(p.x) + p.width + Math.abs(p.z)));
  return (
    <>
      <Rig pose={pose} />
      <Ground size={reach * 8 + 4000} />
      <Clouds reach={Math.max(600, reach * 0.8)} />
      {placements.map((p) => {
        const o = scene.objects.find((x) => x.id === p.id)!;
        const load = o.carries ? scene.objects.find((x) => x.id === o.carries)?.height_m : undefined;
        return <PlacedModel key={p.id} kind={o.kind} p={p} load={load} />;
      })}
    </>
  );
};
