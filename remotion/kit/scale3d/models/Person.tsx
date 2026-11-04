import React from "react";
import { Built, C } from "./geo";

/** A worker in a hard hat, facing +z. Height is head to foot (hat included). */
export const Person: React.FC<{ height: number }> = ({ height: H }) => (
  <Built
    deps={[H]}
    build={(m) => {
      const s = H / 1.8;
      for (const x of [-1, 1]) {
        m.block(x * 0.1 * s, 0, 0.04 * s, 0.13 * s, 0.07 * s, 0.28 * s, C.black); // shoes
        m.block(x * 0.1 * s, 0.07 * s, 0, 0.15 * s, 0.8 * s, 0.17 * s, C.pants); // legs
        m.block(x * 0.27 * s, 0.9 * s, 0, 0.1 * s, 0.6 * s, 0.12 * s, C.shirt); // arms
        m.blob(x * 0.27 * s, 0.88 * s, 0, 0.06 * s, 0.06 * s, 0.06 * s, C.skin); // hands
      }
      m.block(0, 0.85 * s, 0, 0.42 * s, 0.6 * s, 0.24 * s, C.shirt); // torso
      m.block(0, 0.85 * s, 0, 0.43 * s, 0.07 * s, 0.25 * s, C.dark); // belt
      m.block(0, 1.0 * s, -0.17 * s, 0.3 * s, 0.38 * s, 0.1 * s, C.steelDark); // backpack
      m.cyl(0, 1.45 * s, 0, 0.05 * s, 0.05 * s, 0.06 * s, C.skin, 8); // neck
      m.blob(0, 1.58 * s, 0, 0.13 * s, 0.15 * s, 0.13 * s, C.skin, 1); // head
      m.blob(0, 1.68 * s, 0, 0.155 * s, 0.1 * s, 0.155 * s, C.steel, 1); // hard hat
      m.block(0, 1.64 * s, 0.1 * s, 0.26 * s, 0.025 * s, 0.14 * s, C.steel); // brim
    }}
  />
);
