// Finish: ambient occlusion (grounds objects with soft contact darkening), a soft bloom, ACES tone mapping and a gentle grade
// (a touch of saturation and contrast, subtle vignette). Uses three's own postprocessing passes, so it needs no extra package.
import React, { useLayoutEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

const FINISH = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uVig: { value: 0.22 }, uSat: { value: 1.12 }, uCon: { value: 1.05 } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uVig, uSat, uCon; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, uSat);
      c = (c - 0.5) * uCon + 0.5;
      vec2 d = vUv - 0.5; d.x *= 0.85;
      c *= 1.0 - uVig * smoothstep(0.25, 0.85, length(d));
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export type PostSettings = { ao: boolean; bloom: number; vignette: number };
export const POST_DEFAULT: PostSettings = { ao: true, bloom: 0.2, vignette: 0.22 };

export const Post: React.FC<{ settings?: PostSettings }> = ({ settings = POST_DEFAULT }) => {
  const { gl, scene, camera, size } = useThree();
  const composer = useMemo(() => {
    const rt = new THREE.WebGLRenderTarget(size.width, size.height, { type: THREE.HalfFloatType, samples: 4 });
    const c = new EffectComposer(gl, rt);
    c.addPass(new RenderPass(scene, camera));
    if (settings.ao) {
      const ao = new GTAOPass(scene, camera, size.width, size.height);
      ao.updateGtaoMaterial({ radius: 2.5, distanceExponent: 1.2, thickness: 3, scale: 1.1, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 12 });
      ao.blendIntensity = 0.85;
      // The AO pass draws every visible mesh with a normal material; sky, water and glass must not take part.
      const render = ao.render.bind(ao);
      ao.render = (...args: Parameters<GTAOPass["render"]>) => {
        const hidden: THREE.Object3D[] = [];
        scene.traverse((o) => { if (o.userData.noAO && o.visible) { o.visible = false; hidden.push(o); } });
        render(...args);
        hidden.forEach((o) => { o.visible = true; });
      };
      c.addPass(ao);
    }
    if (settings.bloom > 0) c.addPass(new UnrealBloomPass(new THREE.Vector2(size.width, size.height), settings.bloom, 0.55, 0.88));
    c.addPass(new OutputPass());
    const fin = new ShaderPass(FINISH);
    fin.uniforms.uVig!.value = settings.vignette;
    c.addPass(fin);
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, settings.ao, settings.bloom, settings.vignette]);
  useLayoutEffect(() => { composer.setSize(size.width, size.height); }, [composer, size.width, size.height]);
  useFrame(() => { composer.render(); }, 1);
  return null;
};
