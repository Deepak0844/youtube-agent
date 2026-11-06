// "s3k": the 3D authoring kit. A scene file imports ONLY from here and from "three" (plus react/remotion basics).
// THIS FILE IS THE LIST OF EXPORTS: api.d.ts must document every name below (a unit test fails when they differ); API.md is generated from api.d.ts.
// Kit code may only `import type` from src/. Examples live in ./examples (imitate them; they are not part of this barrel).
export type { SceneProps, SceneBeat } from "./meta";
export { Stage } from "./Stage";
export { World, resolvePreset } from "./World";
export { CutawayBox, buildCutFace, strataUV } from "./Cutaway";
export { Finish, resolveFinish } from "./Finish";
export { CameraRig } from "./Rig";
export { Hero } from "./Hero";
export { frameFocus, coverage, glideTimes, resolveShots, rigPose, heroWeight } from "./framing";
export { Captions, Ruler, captionPhase } from "./Overlays";
export { useT, useStable, TimeContext } from "./time";
export { useModels, useHold, fitModel, fitScale, idResolver } from "./models";
export { instance, placeSlots, rowSlots, ringSlots, gridSlots } from "./instancing";
export { makeParticles, particleSeeds, phaseOf } from "./particles";
export { rest, groundSnap, lowestY } from "./rest";
export { std, steel, glow, box, cyl, between, sector, ring, shadowize, ENV_K } from "./parts";
export { rnd, clamp, lerp, smooth, ramp } from "./rng";
export { STRATA_DEFAULT, layerEdges, strataTexture, pebbleTexture, sandTexture, rippleTexture, paveTexture, asphaltTexture, concreteTexture, beltTexture, signTexture, dustSprite, glassWaterTexture, toTexture } from "./textures";
export { tower, glassTower, towerMaterials, farSkyline, facadeTexture } from "./city";
export { WORLD_PRESETS, PRESET_NAMES, PRESET_LIMITS, presetProblems, fitSunFrustum, sunVector, restOffset, floaters } from "./presets";
export { FINISH_DEFAULTS, FINISH_LIMITS } from "./Finish";
export { TILT_LIMIT_DEG } from "./Cutaway";
export { FOV_DEG, SAFE_PORTRAIT, SAFE_WIDE, safeFor } from "./framing";
