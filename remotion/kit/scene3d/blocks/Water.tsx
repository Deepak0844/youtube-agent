// Water block: a stylised turquoise sea with depth colour, soft shoreline foam, a floor lit by moving caustics, and a glass cut face.
// Ideas ported from github.com/Aureliengmz/clearwater (MIT, WebGL2 shallow-water demo): Beer-Lambert style absorption with depth,
// a Fresnel mix between the body colour and the sky, a sharp sun glint, light caustics on the floor and foam where the water is thin.
// Clearwater solves waves with an FFT and a height simulation; here the waves are a sum of four travelling sines plus fine ripples
// (cheap, deterministic per frame, no simulation state), and caustics are a procedural pattern that fades with depth. No clearwater code is copied.
// The depth comes from field.ts, so water meets any land, pile or ring wall the scene places in it.
import React, { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { ElOf } from "../ctx";
import { useBlock } from "../ctx";
import { animAt } from "../anim";
import { buildWaterField } from "../field";
import { gradientStrip } from "../textures";
import { SKY } from "./Atmosphere";

const NOISE = `
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
// Caustic-like bright network: where two drifting sine lattices both peak.
float caustic(vec2 p, float t){
  vec2 q = p + 0.35*vec2(sin(p.y*0.9 + t*0.9), cos(p.x*0.8 - t*0.7));
  float a = abs(sin(q.x*1.7 + sin(q.y*1.3 + t*0.6)));
  float b = abs(sin(q.y*1.5 + sin(q.x*1.1 - t*0.5)));
  float c = abs(sin((q.x+q.y)*1.1 + t*0.4));
  return pow(1.0 - min(min(a, b), c), 7.0);
}`;

const WAVES = `
  const vec2 K0 = vec2(0.21, 0.09), K1 = vec2(-0.13, 0.17), K2 = vec2(0.33, -0.27), K3 = vec2(-0.41, -0.22);
  vec3 waves(vec2 p, float t){
    float h = 0.0; vec2 g = vec2(0.0);
    float a0 = 0.16*sin(dot(K0,p) + t*0.9);  h += a0; g += 0.16*cos(dot(K0,p)+t*0.9)*K0;
    float a1 = 0.12*sin(dot(K1,p) + t*1.1);  h += a1; g += 0.12*cos(dot(K1,p)+t*1.1)*K1;
    float a2 = 0.07*sin(dot(K2,p) + t*1.5);  h += a2; g += 0.07*cos(dot(K2,p)+t*1.5)*K2;
    float a3 = 0.05*sin(dot(K3,p) + t*1.9);  h += a3; g += 0.05*cos(dot(K3,p)+t*1.9)*K3;
    return vec3(h, g);
  }`;

export const Water: React.FC<{ el: ElOf<"water"> }> = ({ el }) => {
  const { scene, t, sunDir, fog } = useBlock();
  const [W, D] = el.size_m;
  const sky = SKY[scene.world.sky];
  const key = useRef("");

  const field = useMemo(() => {
    const f = buildWaterField(scene, el, t, 768, 192);
    const tex = new THREE.DataTexture(f.data, f.w, f.h, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return { tex, f };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el.id]);
  // Rebuild only when a pile is growing (the key changes with pour progress).
  const pk = scene.elements.map((e) => (e.kind === "sand_pile" ? (animAt(e.animations, t).pour ?? 1).toFixed(3) : "")).join("|");
  useLayoutEffect(() => {
    if (key.current === pk) return;
    key.current = pk;
    const f = buildWaterField(scene, el, t, field.f.w, field.f.h);
    field.f.data.set(f.data);
    field.tex.needsUpdate = true;
  }, [pk, scene, el, t, field]);

  const common = useMemo(() => ({
    uField: { value: field.tex },
    uC: { value: new THREE.Vector2(el.at.x, el.at.z) },
    uSize: { value: new THREE.Vector2(W, D) },
    uDepthM: { value: el.depth_m },
    uTime: { value: 0 },
  }), [field, el.at.x, el.at.z, W, D, el.depth_m]);
  common.uTime.value = t;

  const surface = useMemo(() => new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      ...common,
      uShallow: { value: new THREE.Color(el.shallow_color) },
      uDeep: { value: new THREE.Color(el.deep_color) },
      uTop: { value: new THREE.Color(sky.top) },
      uHor: { value: new THREE.Color(sky.horizon) },
      uSun: { value: sunDir.clone() },
      uSunCol: { value: new THREE.Color(sky.sun) },
      uFogCol: { value: new THREE.Color(sky.fog) },
      uFog: { value: new THREE.Vector2(fog.near, fog.far) },
    },
    vertexShader: `${WAVES}
      uniform float uTime; varying vec3 vW; varying vec3 vN;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vec3 wv = waves(w.xz, uTime);
        w.y += wv.x;
        vW = w.xyz; vN = normalize(vec3(-wv.y, 1.0, -wv.z));
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `${NOISE}
      uniform sampler2D uField; uniform vec2 uC, uSize, uFog; uniform float uDepthM, uTime;
      uniform vec3 uShallow, uDeep, uTop, uHor, uSun, uSunCol, uFogCol;
      varying vec3 vW; varying vec3 vN;
      void main(){
        vec2 uv = (vW.xz - uC) / uSize + 0.5;
        vec4 f = texture2D(uField, uv);
        float land = smoothstep(0.35, 0.65, f.g);
        if (land > 0.98) discard;
        float depth = max(f.b * uDepthM, 0.0);
        vec3 V = normalize(cameraPosition - vW);
        // fine ripples on top of the big waves
        vec2 p = vW.xz;
        vec2 rip = vec2(vnoise(p*0.7 + uTime*0.25) - 0.5, vnoise(p*0.7 + 7.3 - uTime*0.2) - 0.5) * 0.22
                 + vec2(vnoise(p*2.0 - uTime*0.4) - 0.5, vnoise(p*2.0 + 3.1 + uTime*0.35) - 0.5) * 0.07;
        vec3 N = normalize(vN + vec3(rip.x, 0.0, rip.y));
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 body = mix(uShallow, uDeep, (1.0 - exp(-depth * 0.12)) * 0.8);
        vec3 R = reflect(-V, N);
        vec3 refl = mix(uHor, uTop, clamp(R.y * 1.4, 0.0, 1.0));
        vec3 col = mix(body, mix(refl, uHor, 0.5), clamp(fres * 0.5, 0.0, 0.6));
        float sp = pow(max(dot(R, normalize(uSun)), 0.0), 260.0);
        col += uSunCol * sp * 0.9;
        // shoreline foam: soft band where the water is thin, with drifting lacy pattern
        float shore = 1.0 - smoothstep(0.0, 1.3, depth);
        float lace = vnoise(p*2.2 + vec2(uTime*0.25, -uTime*0.18)) * 0.6 + vnoise(p*6.0 - uTime*0.3) * 0.4;
        float foam = shore * smoothstep(0.38, 0.62, lace + shore * 0.55);
        foam += (1.0 - smoothstep(0.0, 0.18, depth)) * 0.9;
        foam = clamp(foam, 0.0, 1.0);
        col = mix(col, vec3(1.0), foam * 0.9);
        float a = mix(0.5, 0.9, 1.0 - exp(-depth * 0.5)) + fres * 0.15;
        a = max(a, foam * 0.92) * (1.0 - land);
        float d = length(cameraPosition - vW);
        col = mix(col, uFogCol, smoothstep(uFog.x, uFog.y, d));
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
      }`,
  }), [common, el.shallow_color, el.deep_color, sky, sunDir]);
  surface.uniforms.uFog!.value.set(fog.near, fog.far);

  // Floor: colour by closeness to shore (sand to teal to blue) and moving caustics that fade with depth.
  const floor = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, common, { uSunCol: { value: new THREE.Color(sky.sun) } });
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vWp;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvWp = (modelMatrix * vec4(position,1.0)).xyz;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", `#include <common>\n${NOISE}\nvarying vec3 vWp; uniform sampler2D uField; uniform vec2 uC, uSize; uniform float uDepthM, uTime; uniform vec3 uSunCol;`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          vec2 fuv = (vWp.xz - uC) / uSize + 0.5;
          vec4 fd = texture2D(uField, fuv);
          float sh0 = fd.r;
          vec3 deepC = vec3(0.012, 0.26, 0.45), midC = vec3(0.11, 0.56, 0.56), shalC = vec3(0.89, 0.78, 0.52);
          vec3 fc = mix(deepC, midC, min(1.0, sh0 * 1.4));
          fc = mix(fc, shalC, max(0.0, sh0 - 0.55) * 2.0);
          float dep = uDepthM;
          float cs = caustic(vWp.xz * 0.55, uTime) * 0.8 + caustic(vWp.xz * 0.9 + 4.0, uTime * 1.3) * 0.5;
          fc += uSunCol * cs * (0.22 + 0.5 * sh0);
          diffuseColor.rgb = fc;`);
    };
    return m;
  }, [common, sky.sun]);

  const glassTex = useMemo(() => gradientStrip([[0, "#8cebe8"], [0.5, "#27aed0"], [1, "#0a4f9c"]], 256), []);
  const surfaceGeo = useMemo(() => new THREE.PlaneGeometry(W, D, Math.min(300, Math.ceil(W / 3)), Math.min(120, Math.ceil(D / 3))).rotateX(-Math.PI / 2), [W, D]);
  const zFront = D / 2;
  return (
    <group position={[el.at.x, 0, el.at.z]}>
      <mesh position={[0, el.level_y - el.depth_m, 0]} rotation={[-Math.PI / 2, 0, 0]} material={floor} receiveShadow>
        <planeGeometry args={[W, D]} />
      </mesh>
      <mesh geometry={surfaceGeo} material={surface} position={[0, el.level_y, 0]} renderOrder={2} frustumCulled={false} userData={{ noAO: true }} />
      <mesh position={[0, el.level_y - el.depth_m / 2, zFront + 0.02]} renderOrder={3} userData={{ noAO: true }}>
        <planeGeometry args={[W, el.depth_m]} />
        <meshBasicMaterial map={glassTex} transparent opacity={0.78} depthWrite={false} />
      </mesh>
      <mesh position={[0, el.level_y + 0.05, zFront + 0.03]}><boxGeometry args={[W, 0.25, 0.12]} /><meshBasicMaterial color="#e9fbff" /></mesh>
    </group>
  );
};
