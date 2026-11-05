// The finish chain from the proof: RenderPass -> GTAO (soft contact shadows) -> Bokeh depth of field that follows the target ->
// UnrealBloom -> vignette + a touch of saturation -> OutputPass (tone mapping + sRGB). Rendered into an MSAA half-float target,
// so edges are smooth and bright lights keep their value for the bloom. One component, sensible defaults, a fast mode.
// Put <Finish /> LAST in the stage: it takes over rendering (useFrame priority 1), so nothing after it draws.
import React, { useLayoutEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { useStable } from "./time";

export type FinishProps = {
  /** What is in focus: a world point [x, y, z] (depth of field follows the distance to it), a distance in metres, or nothing = the camera rig's target. */
  focus?: [number, number, number] | number;
  /** "full" (default) = everything on; "fast" = no AO, no depth of field, 2x MSAA, for quick previews. */
  mode?: "full" | "fast";
  /** Ambient occlusion on/off (default on in full mode). */
  ao?: boolean;
  /** Depth of field strength: 0 = off, 1 = default (default 1 in full mode). Limit 0..3. */
  dof?: number;
  /** Bloom strength 0..1.5 (default 0.32). */
  bloom?: number;
  /** Corner darkening 0..0.8 (default 0.42). */
  vignette?: number;
  /** Saturation multiplier 0.5..1.5 (default 1.08). */
  saturation?: number;
};

export const FINISH_DEFAULTS = { bloom: 0.32, vignette: 0.42, saturation: 1.08, dof: 1 } as const;
export const FINISH_LIMITS = { dof: [0, 3], bloom: [0, 1.5], vignette: [0, 0.8], saturation: [0.5, 1.5] } as const;

/** Clamps every knob into its limit and applies the mode, so a model-written value can never break the picture. Pure. */
export function resolveFinish(p: FinishProps): { ao: boolean; dof: number; bloom: number; vignette: number; saturation: number; samples: number } {
  const fast = p.mode === "fast";
  const c = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  return {
    ao: p.ao ?? !fast,
    dof: fast ? 0 : c(p.dof ?? FINISH_DEFAULTS.dof, FINISH_LIMITS.dof),
    bloom: c(p.bloom ?? FINISH_DEFAULTS.bloom, FINISH_LIMITS.bloom),
    vignette: c(p.vignette ?? FINISH_DEFAULTS.vignette, FINISH_LIMITS.vignette),
    saturation: c(p.saturation ?? FINISH_DEFAULTS.saturation, FINISH_LIMITS.saturation),
    samples: fast ? 2 : 4,
  };
}

const VIGNETTE_GRADE = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, amount: { value: 0.42 }, soft: { value: 0.75 }, sat: { value: 1.08 } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
  fragmentShader: `uniform sampler2D tDiffuse; uniform float amount; uniform float soft; uniform float sat; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); vec2 d = vUv - 0.5; d.x *= 0.85; float v = smoothstep(soft, 0.2, length(d));
      c.rgb *= mix(1.0 - amount, 1.0, v); float l = dot(c.rgb, vec3(0.299,0.587,0.114)); c.rgb = mix(vec3(l), c.rgb, sat); gl_FragColor = c; }`,
};

/** Runs a pass with sky, glass and other `userData.noAO` objects hidden (they must not take part in AO or blur depth). */
const withoutNoAO = <A extends unknown[]>(scene: THREE.Scene, render: (...a: A) => void) => (...a: A): void => {
  const hidden: THREE.Object3D[] = [];
  scene.traverse((o) => { if (o.userData.noAO && o.visible) { o.visible = false; hidden.push(o); } });
  render(...a);
  hidden.forEach((o) => { o.visible = true; });
};

export const Finish: React.FC<FinishProps> = (props) => {
  const stable = useStable(props);
  const { gl, scene, camera, size } = useThree();
  const o = useMemo(() => resolveFinish(stable), [stable]);
  const { composer, bokeh } = useMemo(() => {
    const w = size.width, h = size.height;
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: o.samples });
    const comp = new EffectComposer(gl, rt);
    comp.setPixelRatio(1);
    comp.setSize(w, h);
    comp.addPass(new RenderPass(scene, camera));
    if (o.ao) {
      const gtao = new GTAOPass(scene, camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.updateGtaoMaterial({ radius: 2.4, distanceExponent: 1.5, thickness: 2.5, scale: 1.0, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 12 });
      gtao.blendIntensity = 1.0;
      gtao.render = withoutNoAO(scene, gtao.render.bind(gtao));
      comp.addPass(gtao);
    }
    let bk: BokehPass | null = null;
    if (o.dof > 0) {
      bk = new BokehPass(scene, camera, { focus: 50, aperture: 0.00005 * o.dof, maxblur: 0.0045 });
      bk.render = withoutNoAO(scene, bk.render.bind(bk));
      comp.addPass(bk);
    }
    if (o.bloom > 0) comp.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), o.bloom, 0.55, 0.88));
    const v = new ShaderPass(VIGNETTE_GRADE);
    v.uniforms.amount!.value = o.vignette;
    v.uniforms.sat!.value = o.saturation;
    comp.addPass(v);
    comp.addPass(new OutputPass());
    return { composer: comp, bokeh: bk };
    // the size is applied by the layout effect below; rebuilding on resize is not needed for fixed-size renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, o]);
  useLayoutEffect(() => { composer.setSize(size.width, size.height); }, [composer, size.width, size.height]);
  useLayoutEffect(() => () => { composer.dispose(); }, [composer]);

  useFrame(() => {
    if (bokeh) {
      const target = stable.focus;
      let dist = 50;
      if (typeof target === "number") dist = target;
      else {
        const p = Array.isArray(target) ? new THREE.Vector3(...target) : (camera.userData.s3kTarget as THREE.Vector3 | undefined);
        if (p) dist = camera.position.distanceTo(p);
      }
      (bokeh.uniforms as unknown as { focus: { value: number } }).focus.value = dist;
    }
    composer.render();
  }, 1);
  return null;
};
