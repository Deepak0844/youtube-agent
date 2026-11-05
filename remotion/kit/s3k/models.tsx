// Model loader: loads catalogue GLBs by id through a ModelResolver you pass in (the host decides where files live), holds the render
// until they are in (delayRender / continueRender), and hands out fitted clones: base on y = 0, centred on x/z, scaled to a size you give
// (or the catalogue's default scale). A missing model becomes a plain grey stand-in, never a crash.
import React, { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { useThree } from "@react-three/fiber";
import { continueRender, delayRender } from "remotion";
import type { ModelResolver } from "../../../src/shared/scene3d/resolver";
import { fitScale, type FitOptions, type ModelInfo } from "./fit";

export type { ModelResolver };
export { fitScale, type FitOptions, type ModelInfo };
/** A resolver for catalogue ids: `urlFor(id)` gives the file URL (in a render: staticFile("assets3d/files/<id>.glb")). */
export const idResolver = (urlFor: (id: string) => string): ModelResolver => ({
  resolve: (ref) => ("catalog" in ref ? { url: urlFor(ref.catalog) } : null),
});

/** Clones a loaded glTF scene: base on y = 0, centred on x/z, scaled per `o`. `userData.size` holds the final size in metres. */
export function fitModel(source: THREE.Object3D, o: FitOptions = {}): THREE.Group {
  const root = SkeletonUtils.clone(source);
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(root), sz = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
  const s = fitScale(sz, o);
  const wrap = new THREE.Group(), inner = new THREE.Group();
  root.position.set(-c.x, -b.min.y, -c.z);
  inner.add(root); inner.scale.setScalar(s); wrap.add(inner);
  root.traverse((m) => {
    const mesh = m as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const out = mats.map((mat) => {
      const st = mat as THREE.MeshStandardMaterial;
      if (st.metalness === undefined) return mat;
      const c2 = st.clone(); c2.envMapIntensity = 0.7;
      if (o.matte !== false) { c2.metalness = Math.min(st.metalness ?? 0, 0.25); c2.roughness = Math.max(st.roughness ?? 0.8, 0.6); }
      return c2;
    });
    mesh.material = Array.isArray(mesh.material) ? out : out[0]!;
  });
  wrap.userData.size = sz.clone().multiplyScalar(s);
  return wrap;
}

export type Models = {
  /** True when the id was loaded (false = it will be a stand-in). */
  has: (id: string) => boolean;
  /** A fitted clone of the model; a grey box stand-in when it is missing. Each call returns a new object. */
  get: (id: string, o?: FitOptions) => THREE.Group;
};

/** Loads every id once, holds the render until done. Returns null while loading (render nothing until then). */
export function useModels(ids: readonly string[], resolver: ModelResolver, info?: (id: string) => ModelInfo | undefined): Models | null {
  const key = ids.join("|");
  const [loaded, setLoaded] = useState<Record<string, THREE.Object3D> | null>(null);
  const [handle] = useState(() => delayRender("s3k models", { timeoutInMilliseconds: 180000 }));
  useEffect(() => {
    const loader = new GLTFLoader();
    let live = true;
    Promise.all(key.split("|").filter(Boolean).map(async (id): Promise<[string, THREE.Object3D | null]> => {
      const r = resolver.resolve({ catalog: id });
      if (!r) return [id, null];
      try { return [id, (await loader.loadAsync(r.url)).scene]; } catch { return [id, null]; }
    })).then((arr) => { if (live) setLoaded(Object.fromEntries(arr.filter((e): e is [string, THREE.Object3D] => e[1] !== null))); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // Release the render hold only after the scene built from these models has been DRAWN once. Remotion's canvas draws only when told to
  // (once per frame change), so draw by hand now that the models are in (child effects have already run), then continue.
  const { advance } = useThree();
  useEffect(() => {
    if (!loaded) return;
    advance(performance.now());
    continueRender(handle);
  }, [loaded, advance, handle]);
  return useMemo(() => {
    if (!loaded) return null;
    return {
      has: (id) => id in loaded,
      get: (id, o = {}) => {
        const src = loaded[id];
        if (!src) { const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: "#9aa3ab" })); m.position.y = 0.5; m.castShadow = true; g.add(m); g.scale.setScalar(o.size ?? 1); g.userData.size = new THREE.Vector3(1, 1, 1).multiplyScalar(o.size ?? 1); return g; }
        return fitModel(src, { info: info?.(id), ...o });
      },
    };
  }, [loaded, info]);
}

/** Holds the render while an async set-up (your own loading) runs. Call `done()` once; use for anything not covered by useModels. */
export const useHold = (label: string): (() => void) => {
  const [h] = useState(() => delayRender(label, { timeoutInMilliseconds: 120000 }));
  return React.useCallback(() => continueRender(h), [h]);
};
