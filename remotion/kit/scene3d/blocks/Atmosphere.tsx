// Atmosphere: sky dome per preset, sun, haze (fog), soft shadows that follow the camera, and an environment map made from the sky itself
// (a procedural stand-in for a Poly Haven HDRI, so nothing is downloaded at render time).
import React, { useLayoutEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Scene3d } from "../../../../src/shared/scene3d/schema";

type Preset = { top: string; mid: string; horizon: string; fog: string; sun: string; sunK: number; hemiSky: string; hemiGround: string; hemiK: number; env: number; glow: number };
export const SKY: Record<Scene3d["world"]["sky"], Preset> = {
  clear: { top: "#5ea7e6", mid: "#a9d3f2", horizon: "#e3f0f7", fog: "#dcebf3", sun: "#fff1dc", sunK: 1, hemiSky: "#dff0ff", hemiGround: "#f0dcb8", hemiK: 0.35, env: 0.9, glow: 0.55 },
  haze: { top: "#a9cfe8", mid: "#d3e6f0", horizon: "#eaf0f1", fog: "#e9eff2", sun: "#fff0d8", sunK: 1, hemiSky: "#e4f2ff", hemiGround: "#f1dcb4", hemiK: 0.45, env: 0.85, glow: 0.4 },
  dusk: { top: "#35417f", mid: "#d98a8c", horizon: "#f8b98a", fog: "#e9b08e", sun: "#ffb27a", sunK: 0.85, hemiSky: "#8f8fd0", hemiGround: "#c98a6a", hemiK: 0.5, env: 0.7, glow: 1 },
  overcast: { top: "#8e99a3", mid: "#bcc5cb", horizon: "#d9dee1", fog: "#d3d9dc", sun: "#f4f4f2", sunK: 0.35, hemiSky: "#dfe6ea", hemiGround: "#b8b4aa", hemiK: 0.8, env: 0.9, glow: 0 },
};

export const sunDirection = (azimuthDeg: number, elevationDeg: number): THREE.Vector3 => {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).normalize();
};

const skyMaterial = (p: Preset, sun: THREE.Vector3, gain: number) =>
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(p.top) },
      uMid: { value: new THREE.Color(p.mid) },
      uHor: { value: new THREE.Color(p.horizon) },
      uSun: { value: sun.clone() },
      uSunCol: { value: new THREE.Color(p.sun) },
      uGlow: { value: p.glow },
      uGain: { value: gain },
    },
    vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `
      varying vec3 vDir; uniform vec3 uTop,uMid,uHor,uSun,uSunCol; uniform float uGlow,uGain;
      void main(){
        float h = vDir.y;
        vec3 c = mix(uHor, uMid, smoothstep(0.0, 0.18, h));
        c = mix(c, uTop, smoothstep(0.12, 0.8, h));
        c = mix(c, uHor, smoothstep(0.0, -0.1, h));
        float s = max(dot(normalize(vDir), uSun), 0.0);
        c += uSunCol * (pow(s, 6.0) * 0.25 + pow(s, 120.0) * 0.9 + pow(s, 1500.0) * 3.0) * uGlow;
        gl_FragColor = vec4(c * uGain, 1.0);
      }`,
  });

export type AtmosphereProps = { world: Scene3d["world"]; focus: [number, number, number]; span: number };

export const Atmosphere: React.FC<AtmosphereProps> = ({ world, focus, span }) => {
  const { scene, gl } = useThree();
  const preset = SKY[world.sky];
  const sun = useMemo(() => sunDirection(world.sun.azimuth_deg, world.sun.elevation_deg), [world.sun.azimuth_deg, world.sun.elevation_deg]);
  const dome = useMemo(() => skyMaterial(preset, sun, 1), [preset, sun]);
  const light = useRef<THREE.DirectionalLight>(null);
  const tgt = useMemo(() => new THREE.Object3D(), []);

  // Environment map from the sky (once per preset). Lit by it, materials pick up sky colour above and warm ground bounce below.
  useLayoutEffect(() => {
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMaterial(preset, sun, preset.env)));
    const floor = new THREE.Mesh(new THREE.CircleGeometry(100, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(preset.hemiGround).multiplyScalar(0.7) }));
    floor.position.y = -1;
    envScene.add(floor);
    const pm = new THREE.PMREMGenerator(gl);
    const rt = pm.fromScene(envScene, 0.02);
    scene.environment = rt.texture;
    scene.fog = new THREE.Fog(new THREE.Color(preset.fog), world.fog?.near_m ?? 120, world.fog?.far_m ?? 700);
    scene.background = new THREE.Color(preset.fog);
    pm.dispose();
    return () => { rt.dispose(); scene.environment = null; };
  }, [gl, scene, preset, sun, world.fog?.near_m, world.fog?.far_m]);

  // Shadows follow what the camera looks at, sized to the shot, snapped to a texel grid so they do not crawl.
  useLayoutEffect(() => {
    const l = light.current;
    if (!l) return;
    l.target = tgt;
    const half = Math.min(520, Math.max(30, span));
    const texel = (2 * half) / 4096;
    const f = focus.map((v) => Math.round(v / (texel * 8)) * texel * 8) as [number, number, number];
    l.target.position.set(f[0], f[1], f[2]);
    l.position.set(f[0] + sun.x * 500, f[1] + sun.y * 500, f[2] + sun.z * 500);
    l.target.updateMatrixWorld();
    const c = l.shadow.camera;
    c.left = -half; c.right = half; c.top = half; c.bottom = -half; c.near = 10; c.far = 1100;
    c.updateProjectionMatrix();
  });

  return (
    <>
      <mesh material={dome} renderOrder={-10} frustumCulled={false} scale={[1, 1, 1]}><sphereGeometry args={[3000, 32, 16]} /></mesh>
      <hemisphereLight args={[preset.hemiSky, preset.hemiGround, preset.hemiK]} />
      <directionalLight ref={light} color={preset.sun} intensity={world.sun.intensity * preset.sunK} castShadow
        shadow-mapSize-width={4096} shadow-mapSize-height={4096} shadow-bias={-0.0004} shadow-normalBias={0.06} shadow-radius={3} />
      <primitive object={tgt} />
    </>
  );
};
