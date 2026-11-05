// World: sky gradient, exponential haze, a sun with a soft shadow frustum fitted to the shot's focus box, environment light baked ONCE
// from a procedural sky (PMREM, no HDRI file), plus an optional ground plane and sea plane out to the horizon.
// Put <World focus={box} /> first inside the stage. Things you add later rest on `ground.y` / `sea.y` (see rest.ts).
import React, { useLayoutEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { fitSunFrustum, presetProblems, sunVector, WORLD_PRESETS, type BoxV, type PresetName, type WorldPreset } from "./presets";
import { paveTexture, rippleTexture, sandTexture } from "./textures";
import { useT } from "./time";

export type GroundSpec = {
  /** Height of the ground surface (default 0). */
  y?: number;
  /** Surface: "pave" light slabs (default), "sand", or "plain" (just `color`). */
  kind?: "pave" | "sand" | "plain";
  /** Metres covered by one texture tile (default 7.5). */
  tile?: number;
  color?: string;
  /** The ground covers z from `zMin` to `zMax` (default: all the way out, +-3500). Use zMax: 0 for the far side of a cut at z = 0. */
  zMin?: number;
  zMax?: number;
};
export type SeaSpec = {
  /** Water level. */
  y: number;
  color?: string;
  /** The sea covers z from `zMin` to `zMax` (default: all the way out). */
  zMin?: number;
  zMax?: number;
  /** A thin white foam line where the sea meets a cut at z = `foamZ` (omit for none). */
  foamZ?: number;
};
export type WorldProps = {
  /** Look: "haze" (the approved default), "clear", "dusk" or "overcast". */
  preset?: PresetName;
  /** Override single preset values (fogDensity, sunIntensity, sunElevationDeg ...). */
  tweak?: Partial<WorldPreset>;
  /** The box the shots look at: the sun's shadow frustum is fitted to it. Make it cover everything visible, not the whole world. */
  focus: BoxV;
  ground?: GroundSpec | false;
  sea?: SeaSpec | false;
  /** Shadow map size (default 4096; 2048 for a fast preview). */
  shadowSize?: 2048 | 4096;
};

const FAR = 3500;
const SKY_FRAG = `
  varying vec3 vDir; uniform vec3 uTop, uMid, uHor, uSun, uSunCol; uniform float uGlow, uGain;
  void main(){
    vec3 d = normalize(vDir);
    float f = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / 3.14159265;       // 0 at the zenith, 0.5 at the horizon
    vec3 c = mix(uTop, uMid, smoothstep(0.0, 0.42, f));
    c = mix(c, uHor, smoothstep(0.42, 0.5, f));
    float s = max(dot(d, uSun), 0.0);
    c += uSunCol * (pow(s, 6.0) * 0.25 + pow(s, 120.0) * 0.9 + pow(s, 1500.0) * 3.0) * uGlow;
    gl_FragColor = vec4(c * uGain, 1.0);
  }`;
const skyMaterial = (p: WorldPreset, sun: THREE.Vector3, gain: number): THREE.ShaderMaterial =>
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uTop: { value: new THREE.Color(p.top) }, uMid: { value: new THREE.Color(p.mid) }, uHor: { value: new THREE.Color(p.horizon) }, uSun: { value: sun.clone() }, uSunCol: { value: new THREE.Color(p.sun) }, uGlow: { value: p.glow }, uGain: { value: gain } },
    vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: SKY_FRAG,
  });

/** The preset with the author's tweaks applied; throws with a clear message when a value is out of range. */
export function resolvePreset(name: PresetName = "haze", tweak?: Partial<WorldPreset>): WorldPreset {
  const p = { ...WORLD_PRESETS[name], ...tweak };
  const bad = presetProblems(p);
  if (bad.length) throw new Error(`World preset "${name}": ${bad.join("; ")}`);
  return p;
}

/** Environment light: the sky dome, a warm ground and the sun as a bright spot, baked once into a PMREM texture. */
function bakeEnvironment(gl: THREE.WebGLRenderer, p: WorldPreset, sun: THREE.Vector3): THREE.Texture {
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMaterial(p, sun, 1)));
  const floor = new THREE.Mesh(new THREE.CircleGeometry(60, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: p.bounce }));
  floor.position.y = -2;
  envScene.add(floor);
  const spot = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(p.sun).multiplyScalar(6) }));
  spot.position.copy(sun).multiplyScalar(40);
  envScene.add(spot);
  const pm = new THREE.PMREMGenerator(gl);
  const tex = pm.fromScene(envScene, 0.02).texture;
  pm.dispose();
  return tex;
}

const planeXZ = (x0: number, x1: number, z0: number, z1: number, y: number, mat: THREE.Material): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2), mat);
  m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
  m.receiveShadow = true;
  return m;
};

export const World: React.FC<WorldProps> = ({ preset = "haze", tweak, focus, ground = false, sea = false, shadowSize = 4096 }) => {
  const { gl, scene } = useThree();
  const t = useT();
  const p = useMemo(() => resolvePreset(preset, tweak), [preset, tweak]);
  const built = useMemo(() => {
    const root = new THREE.Group();
    const dir = sunVector(p.sunAzimuthDeg, p.sunElevationDeg);
    const sunV = new THREE.Vector3(...dir);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), skyMaterial(p, sunV, 1));
    dome.frustumCulled = false; dome.renderOrder = -10; dome.userData.noAO = true;
    root.add(dome);
    // sun + soft shadows, frustum fitted to the focus box
    const sun = new THREE.DirectionalLight(p.sun, p.sunIntensity);
    const f = fitSunFrustum(focus, dir);
    sun.position.set(...f.position); sun.target.position.set(...f.target);
    sun.castShadow = true; sun.shadow.mapSize.set(shadowSize, shadowSize);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = f.left; sc.right = f.right; sc.top = f.top; sc.bottom = f.bottom; sc.near = f.near; sc.far = f.far; sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.06; sun.shadow.radius = 3;
    root.add(sun, sun.target, new THREE.HemisphereLight(p.hemiSky, p.hemiGround, p.hemiK));
    // ground
    let ripple: THREE.Texture | null = null;
    if (ground) {
      const kind = ground.kind ?? "pave", tile = ground.tile ?? 7.5;
      const x0 = -FAR, x1 = FAR, z0 = ground.zMin ?? -FAR, z1 = ground.zMax ?? FAR;
      const map = kind === "plain" ? null : (kind === "sand" ? sandTexture() : paveTexture()).clone();
      if (map) { map.needsUpdate = true; map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set((x1 - x0) / tile, (z1 - z0) / tile); }
      const g = planeXZ(x0, x1, z0, z1, ground.y ?? 0, new THREE.MeshStandardMaterial({ map, color: ground.color ?? "#ffffff", roughness: 0.95, envMapIntensity: 0.5 }));
      root.add(g);
    }
    if (sea) {
      ripple = rippleTexture().clone(); ripple.needsUpdate = true; ripple.wrapS = ripple.wrapT = THREE.RepeatWrapping;
      const z0 = sea.zMin ?? -FAR, z1 = sea.zMax ?? FAR;
      ripple.repeat.set((2 * FAR) / 58, (z1 - z0) / 58);
      root.add(planeXZ(-FAR, FAR, z0, z1, sea.y, new THREE.MeshStandardMaterial({ color: sea.color ?? "#37c6cf", roughness: 0.28, metalness: 0.05, bumpMap: ripple, bumpScale: 1.2, envMapIntensity: 0.9 })));
      if (sea.foamZ !== undefined) {
        const foam = new THREE.Mesh(new THREE.PlaneGeometry(900, 1.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#effcfc", transparent: true, opacity: 0.85 }));
        foam.position.set(0, sea.y + 0.04, sea.foamZ + 0.8);
        root.add(foam);
      }
    }
    const env = bakeEnvironment(gl, p, sunV);
    return { root, env, ripple };
  }, [gl, p, focus, ground, sea, shadowSize]);

  useLayoutEffect(() => {
    scene.fog = new THREE.FogExp2(p.fog, p.fogDensity);
    scene.background = new THREE.Color(p.fog);
    scene.environment = built.env;
    gl.toneMappingExposure = p.exposure;
    return () => { scene.environment = null; built.env.dispose(); };
  }, [scene, gl, built, p]);
  // slow ripple drift on the sea, a pure function of t
  useLayoutEffect(() => { built.ripple?.offset.set(t * 0.004, t * 0.0034); });
  return <primitive object={built.root} />;
};
