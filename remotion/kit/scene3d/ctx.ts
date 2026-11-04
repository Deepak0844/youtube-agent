import React from "react";
import type * as THREE from "three";
import type { Scene3d, Scene3dElement } from "../../../src/shared/scene3d/schema";

/** What every block can read: the scene, the time (seconds), ground height for snapping, loaded models, the sun. */
export type BlockCtx = {
  scene: Scene3d;
  t: number;
  groundAt: (x: number, z: number) => number;
  /** Loaded glTF roots by model key; null = failed to load (blocks draw a stand-in). */
  models: Record<string, THREE.Object3D | null>;
  sunDir: THREE.Vector3;
  /** Quality knob for previews: 1 = full. */
  quality: number;
};
export const BlockContext = React.createContext<BlockCtx>(null as unknown as BlockCtx);
export const useBlock = (): BlockCtx => React.useContext(BlockContext);
export type ElOf<K extends Scene3dElement["kind"]> = Extract<Scene3dElement, { kind: K }>;
