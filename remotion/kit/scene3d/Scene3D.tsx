// The Scene3D composition: a validated scene format v2 in, a portrait 3D video out. three.js is only loaded when this composition is
// (registry.tsx imports it lazily). Everything draws in headless Chrome through WebGL; post-processing runs inside the canvas.
import React, { useEffect, useMemo, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Scene3d, Scene3dElement } from "../../../src/shared/scene3d/schema";
import { cameraAt, cameraKeys, shotAt } from "./camera";
export { scene3dFrames } from "./camera";
import { BlockContext, type BlockCtx } from "./ctx";
import { animAt, groundHeightAt } from "./anim";
import { FOV_DEG } from "./framing";
import { defaultModelUrl, modelKeyOf } from "./models";
import { OriginContext } from "./origin";
import { Atmosphere, sunDirection } from "./blocks/Atmosphere";
import { Post, POST_DEFAULT, type PostSettings } from "./blocks/Post";
import { StrataCut } from "./blocks/Strata";
import { Terrain } from "./blocks/Terrain";
import { Water } from "./blocks/Water";
import { RockPile } from "./blocks/Rocks";
import { SandPile } from "./blocks/Sand";
import { Ship } from "./blocks/Ship";
import { Crowd } from "./blocks/Crowd";
import { Skyline } from "./blocks/Skyline";
import { Clouds } from "./blocks/Clouds";
import { ArrowBlock, RulerBlock, TextLabel } from "./blocks/Annotations";
import { BoxBlock, CylinderBlock, ModelBlock, SphereBlock } from "./blocks/Primitives";

export type Scene3DProps = {
  scene: Scene3d;
  /** Model key ("file:..." / "catalog:...") -> URL, built by the host from its ModelResolver. Local files fall back to the public dir. */
  modelUrls?: Record<string, string>;
  post?: PostSettings;
  /** Draw only this frame's caption pill off (for stills that want the raw 3D). */
  noCaption?: boolean;
};


const FONT = "'Arial Rounded MT Bold', 'Avenir Next Condensed', 'Helvetica Neue', Arial, sans-serif";
const sm = (x: number) => { const u = Math.min(1, Math.max(0, x)); return u * u * u * (u * (u * 6 - 15) + 10); };

/** Caption pill on a dark rounded plate (like the reference): eases in, holds, eases out inside its shot. */
const Caption: React.FC<{ text: string; local: number; dur: number }> = ({ text, local, dur }) => {
  const k = sm((local - 0.15) / 0.3);
  const o = sm((dur - local - 0.05) / 0.25);
  const a = Math.min(k, o);
  if (a <= 0.001) return null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: 190, display: "flex", justifyContent: "center", opacity: a, transform: `translateY(${(1 - k) * 18}px) scale(${0.9 + 0.1 * k})` }}>
      <div style={{ background: "rgba(24,24,26,0.94)", color: "#fff", fontFamily: FONT, fontWeight: 900, fontSize: 104, lineHeight: "118px", padding: "12px 50px 18px", borderRadius: 34, letterSpacing: 2, boxShadow: "0 10px 30px rgba(0,0,0,0.28)", border: "3px solid rgba(255,255,255,0.12)", maxWidth: "88%", textAlign: "center" }}>{text}</div>
    </div>
  );
};

const LOCAL_Y_KINDS = new Set<Scene3dElement["kind"]>(["terrain", "water", "strata_cut"]);

const renderBlock = (el: Scene3dElement): React.ReactNode => {
  switch (el.kind) {
    case "model": return <ModelBlock el={el} />;
    case "terrain": return <Terrain el={el} />;
    case "water": return <Water el={el} />;
    case "strata_cut": return <StrataCut el={el} />;
    case "rock_pile": return <RockPile el={el} />;
    case "sand_pile": return <SandPile el={el} />;
    case "crowd": return <Crowd el={el} />;
    case "text_label": return <TextLabel el={el} />;
    case "arrow": return <ArrowBlock el={el} />;
    case "ruler": return <RulerBlock el={el} />;
    case "box": return <BoxBlock el={el} />;
    case "cylinder": return <CylinderBlock el={el} />;
    case "sphere": return <SphereBlock el={el} />;
    case "ship": return <Ship el={el} />;
    case "skyline": return <Skyline el={el} />;
    case "clouds": return <Clouds el={el} />;
  }
};

/** One element in the world: placement, snap to ground, and its animations (path, rotate, grow, build up). */
const Placed: React.FC<{ el: Scene3dElement; ctx: BlockCtx }> = ({ el, ctx }) => {
  const a = animAt(el.animations, ctx.t);
  const x = a.x ?? el.at.x;
  const z = a.z ?? el.at.z;
  const y = LOCAL_Y_KINDS.has(el.kind) ? (el.at.y ?? 0) : el.at.y ?? (el.at.snap ? ctx.groundAt(x, z) : 0);
  const k = el.at.scale * a.scale;
  const yaw = (el.at.rot_deg * Math.PI) / 180 + a.yaw;
  const origin: [number, number, number] = [x, y, z];
  return (
    <OriginContext.Provider value={origin}>
      <group position={origin} rotation={[0, yaw, 0]} scale={[k, k * Math.max(a.build, 0.001), k]}>{renderBlock(el)}</group>
    </OriginContext.Provider>
  );
};

const useModels = (scene: Scene3d, urls: Record<string, string> | undefined) => {
  const [models, setModels] = useState<Record<string, THREE.Object3D | null> | null>(null);
  const [handle] = useState(() => delayRender("scene3d models", { timeoutInMilliseconds: 120000 }));
  const refs = useMemo(() => {
    const out = new Map<string, string | null>();
    for (const e of scene.elements) if (e.kind === "model") out.set(modelKeyOf(e.model), urls?.[modelKeyOf(e.model)] ?? defaultModelUrl(e.model, staticFile));
    return out;
  }, [scene, urls]);
  useEffect(() => {
    const loader = new GLTFLoader();
    Promise.all([...refs].map(async ([key, url]) => {
      if (!url) return [key, null] as const;
      try { return [key, (await loader.loadAsync(url)).scene as THREE.Object3D] as const; } catch { return [key, null] as const; }
    })).then((arr) => setModels(Object.fromEntries(arr)));
  }, [refs]);
  useEffect(() => { if (models) continueRender(handle); }, [models, handle]);
  return models;
};

const Engine: React.FC<{ scene: Scene3d; t: number; models: Record<string, THREE.Object3D | null>; post: PostSettings }> = ({ scene, t, models, post }) => {
  const { camera, size } = useThree();
  const aspect = size.width / size.height;
  const keys = useMemo(() => cameraKeys(scene, aspect), [scene, aspect]);
  const water = scene.elements.find((e) => e.kind === "water");
  const groundAt = useMemo(() => (x: number, z: number) => groundHeightAt(scene, x, z), [scene]);
  const floorAt = (x: number, z: number) => Math.max(groundAt(x, z), water && water.kind === "water" ? water.level_y : -Infinity, scene.world.ground.y) + 1.2;
  const pose = cameraAt(keys, t, floorAt);
  const cam = camera as THREE.PerspectiveCamera;
  cam.position.set(...pose.position);
  cam.lookAt(...pose.target);
  cam.fov = FOV_DEG;
  cam.near = 0.8;
  cam.far = 5000;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  const sunDir = useMemo(() => sunDirection(scene.world.sun.azimuth_deg, scene.world.sun.elevation_deg), [scene.world.sun]);
  const camDist = Math.hypot(pose.position[0] - pose.target[0], pose.position[1] - pose.target[1], pose.position[2] - pose.target[2]);
  const fog = { near: Math.max(scene.world.fog?.near_m ?? 120, camDist * 0.9), far: Math.max(scene.world.fog?.far_m ?? 700, camDist * 4.5) };
  const ctx: BlockCtx = { scene, t, groundAt, models, sunDir, waterY: water && water.kind === "water" ? water.level_y : -Infinity, fog, quality: 1 };
  const span = Math.hypot(pose.position[0] - pose.target[0], pose.position[1] - pose.target[1], pose.position[2] - pose.target[2]) * 0.75;
  return (
    <BlockContext.Provider value={ctx}>
      <Atmosphere world={scene.world} focus={pose.target} span={span} fog={fog} />
      {scene.elements.map((el) => <Placed key={el.id} el={el} ctx={ctx} />)}
      <Post settings={post} focus={camDist} />
    </BlockContext.Provider>
  );
};

export const Scene3D: React.FC<Scene3DProps> = ({ scene, modelUrls, post = POST_DEFAULT, noCaption }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const models = useModels(scene, modelUrls);
  const t = frame / fps;
  const { index, local } = shotAt(scene.shots, t);
  const shot = scene.shots[index]!;
  return (
    <AbsoluteFill style={{ background: "#dfe9ee" }}>
      {models ? (
        <ThreeCanvas width={width} height={height} shadows camera={{ fov: FOV_DEG, near: 0.8, far: 5000, position: [0, 0, 0] }}
          gl={{ antialias: false, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0 }}
          onCreated={({ gl }) => { gl.shadowMap.type = THREE.PCFSoftShadowMap; }}>
          <Engine scene={scene} t={t} models={models} post={post} />
        </ThreeCanvas>
      ) : null}
      {!noCaption && shot.caption ? <Caption text={shot.caption} local={local} dur={shot.duration_s} /> : null}
    </AbsoluteFill>
  );
};
