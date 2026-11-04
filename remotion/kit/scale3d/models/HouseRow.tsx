import React from "react";
import { Built, C } from "./geo";

const WALLS = [C.wall1, C.wall2, C.wall3, C.wall4, C.wall1];
const ROOFS = [C.roofRed, C.roofBlue, C.roofRed, C.roofBlue, C.roofRed];

/** A terrace of five two-storey houses with gabled roofs, windows, doors, chimneys, steps and hedges. H is the ridge height. */
export const HouseRow: React.FC<{ height: number }> = ({ height: H }) => (
  <Built
    deps={[H]}
    build={(m) => {
      const n = 5;
      const w = (H * 3.2) / n;
      const d = H * 0.85;
      const wall = H * 0.62;
      const x0 = -(n * w) / 2 + w / 2;
      m.block(0, 0, H * 0.4, n * w * 1.04, H * 0.01, d + H * 1.1, C.concrete); // pavement strip
      for (let i = 0; i < n; i++) {
        const x = x0 + i * w;
        m.block(x, 0, 0, w * 0.98, wall, d, WALLS[i]!);
        m.roof(x, wall, 0, w * 1.04, H - wall, d * 1.04, ROOFS[i]!);
        m.block(x + w * 0.28, wall + (H - wall) * 0.45, -d * 0.2, w * 0.1, H * 0.16, w * 0.1, C.roofRed); // chimney
        const zf = d / 2;
        for (const fy of [H * 0.07, H * 0.37]) for (const dx of [-0.26, 0.26]) {
          if (fy < H * 0.1 && dx < 0) continue; // the door takes the ground-floor left slot
          m.block(x + dx * w, fy, zf, w * 0.2, H * 0.17, H * 0.02, C.glassDark);
          m.block(x + dx * w, fy - H * 0.012, zf + H * 0.01, w * 0.26, H * 0.012, H * 0.03, C.white); // sill
        }
        m.block(x - w * 0.26, 0, zf, w * 0.2, H * 0.28, H * 0.02, C.door);
        m.block(x - w * 0.26, 0, zf + H * 0.05, w * 0.3, H * 0.018, H * 0.1, C.concreteDark); // step
        m.block(x, wall + (H - wall) * 0.2, zf, w * 0.16, H * 0.1, H * 0.02, C.glass); // attic window
        m.blob(x + w * 0.2, H * 0.045, zf + H * 0.2, w * 0.2, H * 0.05, H * 0.07, C.leaf3); // hedge
        if (i % 2 === 0) m.block(x - w * 0.43, 0, zf + H * 0.45, H * 0.012, H * 0.3, H * 0.012, C.dark); // lamp post
      }
    }}
  />
);
