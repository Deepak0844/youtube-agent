import React from "react";
import { Built, C } from "./geo";

/** A jagged low-poly mountain with shoulders, a second peak, scree boulders and a snow cap. Width is about 2.2 x H. */
export const Mountain: React.FC<{ height: number }> = ({ height: H }) => (
  <Built
    deps={[H]}
    build={(m) => {
      // [x, height, base radius, colour, sides] as fractions of H
      const peaks: [number, number, number, string, number][] = [
        [0, 1, 0.55, C.mount, 7], [-0.55, 0.62, 0.42, C.mountDark, 6], [0.52, 0.55, 0.4, C.mount, 6], [0.2, 0.74, 0.34, C.mountDark, 5], [-0.2, 0.7, 0.3, C.mount, 5],
      ];
      for (const [x, h, r, c, seg] of peaks) m.cyl(x * H, 0, x * 0.2 * H, 0, r * H, h * H, c, seg);
      m.cyl(0, 0.7 * H, 0, 0, 0.55 * H * 0.3 * 1.04, 0.3 * H * 1.005, C.snow, 7); // snow cap on the main peak
      m.cyl(0.2 * H, 0.54 * H, 0.04 * H, 0, 0.34 * H * 0.27 * 1.04, 0.2 * H * 1.005, C.snow, 5);
      for (const [x, z, r] of [[-0.8, 0.25, 0.05], [0.75, 0.3, 0.04], [0.35, 0.4, 0.035], [-0.4, 0.4, 0.045], [0.95, 0.12, 0.03]] as const) m.blob(x * H, r * H * 0.4, z * H, r * H, r * H * 0.6, r * H, C.mountDark, 0);
    }}
  />
);
