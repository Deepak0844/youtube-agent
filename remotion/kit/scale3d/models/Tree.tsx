import React from "react";
import { Built, C } from "./geo";

// Foliage clusters: [x, y, z, radius] as fractions of the tree's height, in three greens.
const CLUSTERS: [number, number, number, number, string][] = [
  [0, 0.7, 0, 0.3, C.leaf1], [0.2, 0.6, 0.05, 0.22, C.leaf2], [-0.2, 0.62, -0.05, 0.22, C.leaf3], [0.05, 0.9, 0.04, 0.2, C.leaf2],
  [-0.1, 0.5, 0.18, 0.18, C.leaf3], [0.1, 0.52, -0.18, 0.18, C.leaf1], [-0.12, 0.8, -0.1, 0.16, C.leaf1],
];

export const Tree: React.FC<{ height: number }> = ({ height: H }) => (
  <Built
    deps={[H]}
    build={(m) => {
      m.cyl(0, 0, 0, H * 0.03, H * 0.055, H * 0.55, C.trunk, 7);
      m.beam([0, H * 0.35, 0], [H * 0.12, H * 0.55, 0.02 * H], H * 0.025, C.trunk);
      m.beam([0, H * 0.3, 0], [-H * 0.1, H * 0.5, -0.02 * H], H * 0.022, C.trunk);
      for (const [x, y, z, r, c] of CLUSTERS) m.blob(x * H, y * H, z * H, r * H, r * H * 0.85, r * H, c, 1);
    }}
  />
);
