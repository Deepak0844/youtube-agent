// Hero: marks the ONE thing the story is about. It changes nothing on screen. During the app's preview pictures the host asks every Hero
// where it sits in the frame (how wide, and whether it is cut off) and turns that into plain advice; in a normal render it does nothing.
import React from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { heroShot } from "./framing";
import { useT } from "./time";

let probing = false;
/** Host only (Author.tsx): turns the hero report on for preview pictures. Not part of the scene API. */
export const setHeroProbe = (on: boolean): void => { probing = on; };

const CORNER_SIGNS: ReadonlyArray<readonly [number, number, number]> = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];

export const Hero: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const ref = React.useRef<THREE.Group>(null);
  const { camera } = useThree();
  const frame = Math.round(useT() * 30); // the time context re-renders this on every frame, so the report below always matches the picture (30 fps)
  React.useEffect(() => {
    const g = ref.current;
    if (!probing || !g) return;
    g.updateWorldMatrix(true, true);
    g.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).computeBoundingBox(); }); // instance matrices move every frame
    const box = new THREE.Box3().setFromObject(g);
    let shot = { width: 0, height: 0, clipped: true };
    if (!box.isEmpty()) {
      camera.updateMatrixWorld();
      const cam = camera as THREE.PerspectiveCamera;
      const pts = CORNER_SIGNS.map(([a, b, c]) => {
        const v = new THREE.Vector3(a ? box.max.x : box.min.x, b ? box.max.y : box.min.y, c ? box.max.z : box.min.z);
        const behind = v.clone().applyMatrix4(cam.matrixWorldInverse).z >= -cam.near;
        v.project(cam);
        return { x: v.x, y: v.y, behind };
      });
      shot = heroShot(pts);
    }
    console.log(`S3K_HERO ${JSON.stringify({ frame, ...shot })}`);
  });
  return <group ref={ref}>{children}</group>;
};
