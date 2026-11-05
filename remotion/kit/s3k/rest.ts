// The "nothing floats" rule: every object is placed by what it rests on, never by a guessed y.
import * as THREE from "three";
import { restOffset } from "./presets";

/** A plane to rest on: a height, `{ y }`, or a function of (x, z) for uneven ground. */
export type Plane = number | { y: number } | ((x: number, z: number) => number);
const heightAt = (plane: Plane, x: number, z: number): number => (typeof plane === "number" ? plane : typeof plane === "function" ? plane(x, z) : plane.y);

/**
 * Moves `object` straight up or down so its lowest point touches the plane (plus `lift` metres, e.g. 0.03 to stop z-fighting).
 * Call it after the object is positioned in x/z and added to its parent. Returns the object so you can chain it.
 */
export function rest<T extends THREE.Object3D>(object: T, plane: Plane, lift = 0): T {
  object.updateWorldMatrix(true, true);
  const b = new THREE.Box3().setFromObject(object);
  if (b.isEmpty()) return object;
  const c = b.getCenter(new THREE.Vector3());
  const dy = restOffset(b.min.y, heightAt(plane, c.x, c.z), lift);
  const sy = object.parent ? object.parent.getWorldScale(new THREE.Vector3()).y || 1 : 1;
  object.position.y += dy / sy;
  object.updateWorldMatrix(true, true);
  return object;
}
/** Same as `rest`, with the ground as a function of x, z (a slope, a dune): the object sits on the ground under its centre. */
export const groundSnap = <T extends THREE.Object3D>(object: T, ground: (x: number, z: number) => number, lift = 0): T => rest(object, ground, lift);

/** Lowest world-space y of an object (what `rest` aligns). */
export const lowestY = (object: THREE.Object3D): number => new THREE.Box3().setFromObject(object).min.y;
