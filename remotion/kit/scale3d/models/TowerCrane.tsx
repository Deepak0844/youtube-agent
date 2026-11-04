import React from "react";
import { HOOK_X, HOOK_Y_TOP, LOAD_DROP } from "../math";
import { Built, C, LIFT_A, type Merger } from "./geo";

/** Square lattice mast: four legs, rings and zig-zag braces on every level. */
export function lattice(m: Merger, w: number, top: number, levels: number, t: number, color: string, y0 = 0) {
  const h = w / 2;
  const P: [number, number][] = [[-h, -h], [h, -h], [h, h], [-h, h]];
  P.forEach(([x, z]) => m.beam([x, y0, z], [x, top, z], t * 1.5, color));
  const dy = (top - y0) / levels;
  for (let i = 0; i <= levels; i++) {
    const y = y0 + i * dy;
    for (let k = 0; k < 4; k++) {
      const a = P[k]!;
      const b = P[(k + 1) % 4]!;
      m.beam([a[0], y, a[1]], [b[0], y, b[1]], t, color);
      if (i < levels) m.beam([a[0], y, a[1]], [b[0], y + dy, b[1]], t * 0.8, color);
    }
  }
}

/** Tower crane (jib toward +x), base centred on the origin. `load` is the height of a load hanging from the hook, if any. */
export const TowerCrane: React.FC<{ height: number; load?: number; color?: string }> = ({ height: H, load, color = C.steel }) => (
  <Built
    deps={[H, load, color]}
    build={(m) => {
      const w = H * 0.045;
      const t = w * 0.075;
      const top = H * 0.9;
      const levels = Math.min(40, Math.max(4, Math.round(top / (w * 1.25))));
      // foundation and mast
      m.block(0, 0, 0, w * 2.1, H * 0.012, w * 2.1, C.concrete);
      lattice(m, w, top, levels, t, color);
      // slewing ring, cab, A-frame
      const jy = HOOK_Y_TOP * H;
      m.block(0, top, 0, w * 1.4, jy - top, w * 1.4, C.dark);
      m.block(w * 1.0, top + H * 0.004, 0, w * 0.9, H * 0.03, w * 0.9, C.white);
      m.block(w * 1.46, top + H * 0.011, 0, w * 0.04, H * 0.016, w * 0.7, C.glass);
      const apex = H;
      m.beam([0, jy, 0], [0, apex, 0], t * 2, color);
      // jib and counter-jib: two bottom chords, one top chord, zig-zag
      const jh = H * 0.06;
      const jw = w * 0.85;
      const x0 = -H * 0.18;
      const x1 = H * 0.5;
      for (const z of [-jw / 2, jw / 2]) m.beam([x0, jy, z], [x1, jy, z], t * 1.4, color);
      m.beam([x0, jy + jh, 0], [x1, jy + jh, 0], t * 1.4, color);
      const step = jw * 1.3;
      let up = true;
      for (let x = x0; x < x1 - step * 0.5; x += step) {
        const x2 = Math.min(x1, x + step);
        m.beam([x, up ? jy : jy + jh, up ? -jw / 2 : 0], [x2, up ? jy + jh : jy, up ? 0 : -jw / 2], t * 0.8, color);
        m.beam([x, up ? jy : jy + jh, up ? jw / 2 : 0], [x2, up ? jy + jh : jy, up ? 0 : jw / 2], t * 0.8, color);
        up = !up;
      }
      m.beam([x1, jy, -jw / 2], [x1, jy, jw / 2], t, color); // jib tip
      // pendant ties from the apex
      m.beam([0, apex, 0], [x1 * 0.95, jy + jh, 0], t * 0.5, C.cable);
      m.beam([0, apex, 0], [x0 * 0.95, jy + jh, 0], t * 0.5, C.cable);
      // counterweights
      for (let i = 0; i < 3; i++) m.block(x0 * (0.55 + i * 0.16), jy - H * 0.034, 0, w * 0.7, H * 0.034, jw * 1.1, C.concreteDark);
      // trolley, cable, hook block, hook
      const hx = HOOK_X * H;
      m.block(hx, jy - H * 0.01, 0, w * 0.5, H * 0.01, jw * 1.1, C.dark);
      const bw = H * 0.02;
      const bh = H * 0.028;
      const loadTop = (HOOK_Y_TOP - LOAD_DROP) * H; // matches layoutObjects()
      const blockTop = load ? loadTop + H * 0.1 : H * 0.62;
      m.beam([hx, jy - H * 0.01, 0], [hx, blockTop + bh, 0], t * 0.7, C.cable);
      m.block(hx, blockTop, 0, bw, bh, bw * 0.7, C.hook);
      m.cyl(hx, blockTop + bh * 0.55, 0, bw * 0.16, bw * 0.16, bh * 0.6, C.black, 6); // sheave pin look
      m.hook(hx, blockTop - bw * 0.22, 0, bw * 0.28, bw * 0.07, Math.PI * 1.5, C.black);
      if (load) {
        // four slings from the hook block down to the corners of the lifting plate on top of the load
        const a = load * LIFT_A;
        for (const [dx, dz] of [[-a, -a], [a, -a], [a, a], [-a, a]] as const) {
          m.beam([hx, blockTop, 0], [hx + dx, loadTop, dz], t * 0.55, C.cable);
        }
      }
    }}
  />
);
