import React from "react";
import { Built, C, LIFT_A } from "./geo";
import { lattice } from "./TowerCrane";

/**
 * A compact self-erecting crane on a truck-style base, its own design (not a scaled tower crane): wide chassis with
 * wheels and outriggers, a short mast, a fat boom, a cab and ballast. Top is a lifting plate for slings at the origin.
 */
export const SmallCrane: React.FC<{ height: number }> = ({ height: H }) => (
  <Built
    deps={[H]}
    build={(m) => {
      const col = C.red;
      const wm = H * 0.1; // mast width, chunkier than the big crane's
      const t = wm * 0.1;
      // chassis, wheels, outriggers, cab
      m.block(0, H * 0.04, 0, H * 0.6, H * 0.07, H * 0.2, C.dark);
      for (const x of [-H * 0.22, -H * 0.08, H * 0.22]) for (const z of [-H * 0.11, H * 0.11]) m.wheel(x, H * 0.04, z, H * 0.05, H * 0.04, C.black);
      for (const z of [-1, 1]) {
        m.block(-H * 0.28, H * 0.03, z * H * 0.17, H * 0.03, H * 0.03, H * 0.1, C.steelDark);
        m.block(H * 0.28, H * 0.03, z * H * 0.17, H * 0.03, H * 0.03, H * 0.1, C.steelDark);
      }
      m.block(H * 0.2, H * 0.11, 0, H * 0.18, H * 0.09, H * 0.19, C.white);
      m.block(H * 0.292, H * 0.125, 0, H * 0.015, H * 0.05, H * 0.15, C.glass);
      // turntable, ballast, mast
      const topMast = H * 0.74;
      m.block(0, H * 0.11, 0, wm * 1.6, H * 0.04, wm * 1.6, C.steelDark);
      m.block(-H * 0.14, H * 0.11, 0, H * 0.09, H * 0.08, H * 0.12, C.concreteDark);
      lattice(m, wm, topMast, 7, t, col, H * 0.15);
      // boom (toward +x), fat triangular lattice, and the top plate the slings attach to
      const by = topMast;
      m.block(0, by, 0, wm * 1.5, H * 0.04, wm * 1.5, C.dark);
      const bw = wm * 0.9;
      for (const z of [-bw / 2, bw / 2]) m.beam([-H * 0.1, by + H * 0.04, z], [H * 0.34, by + H * 0.04, z], t * 1.6, col);
      m.beam([-H * 0.1, by + H * 0.09, 0], [H * 0.34, by + H * 0.09, 0], t * 1.6, col);
      for (let x = -H * 0.1; x < H * 0.3; x += H * 0.08) {
        m.beam([x, by + H * 0.04, -bw / 2], [x + H * 0.04, by + H * 0.09, 0], t, col);
        m.beam([x + H * 0.04, by + H * 0.09, 0], [x + H * 0.08, by + H * 0.04, bw / 2], t, col);
      }
      // tip block with a small hook, and a mast-top mount that rises exactly to H
      m.block(H * 0.34, by + H * 0.01, 0, H * 0.02, H * 0.06, bw, C.dark);
      m.cyl(H * 0.34, by - H * 0.05, 0, H * 0.004, H * 0.004, H * 0.06, C.cable, 5);
      m.block(H * 0.34, by - H * 0.075, 0, H * 0.016, H * 0.026, H * 0.016, C.hook);
      m.beam([0, by + H * 0.04, 0], [0, H - H * 0.015, 0], t * 2.2, col);
      const a = H * LIFT_A;
      m.block(0, H - H * 0.015, 0, a * 2.4, H * 0.015, a * 2.4, C.steelDark);
    }}
  />
);
