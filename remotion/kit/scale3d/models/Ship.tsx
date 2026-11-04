import React from "react";
import { Built, C } from "./geo";

const BOX = ["#e8826f", "#8fb3d4", "#f3c969", "#8fd19e", "#e6dcf0", "#f5d0d0"];

/** A container ship, bow toward +x. H is keel-to-mast-top; length is 5 x H. */
export const Ship: React.FC<{ height: number }> = ({ height: H }) => (
  <Built
    deps={[H]}
    build={(m) => {
      const L = H * 5;
      const B = H * 0.8;
      const deck = H * 0.22;
      m.block(0, -H * 0.12, 0, L * 1.22, H * 0.14, B * 2.2, C.water); // the water it floats in (top just above the quay)
      m.prism([[-L / 2, 0], [L * 0.38, 0], [L / 2, deck * 0.95], [-L / 2, deck]], B, 0, -H * 0.04, 0, C.hull); // hull with a raked bow
      m.block(0, -H * 0.04 + deck * 0.55, 0, L * 0.98, deck * 0.05, B * 1.02, C.white); // boot-top stripe
      // containers in bays and stacks
      let k = 0;
      for (let bay = 0; bay < 12; bay++) {
        const x = -L * 0.12 + bay * L * 0.062 + L * 0.01;
        if (x > L * 0.4) break;
        for (let row = -1; row <= 1; row++) {
          const stack = 1 + ((bay + row + 3) % 3);
          for (let lv = 0; lv < stack; lv++) m.block(x, deck + lv * H * 0.082 - H * 0.04, row * B * 0.3, L * 0.056, H * 0.078, B * 0.27, BOX[k++ % BOX.length]!);
        }
      }
      // bridge, funnel, mast
      const bx = -L * 0.38;
      const by = deck - H * 0.04;
      m.block(bx, by, 0, L * 0.09, H * 0.3, B * 0.85, C.white);
      m.block(bx, by + H * 0.3, 0, L * 0.07, H * 0.1, B * 0.9, C.white);
      m.block(bx + L * 0.036, by + H * 0.31, 0, L * 0.004, H * 0.05, B * 0.86, C.glassDark);
      m.cyl(bx - L * 0.02, by + H * 0.3, 0, H * 0.06, H * 0.075, H * 0.2, C.red, 8);
      m.cyl(bx, by + H * 0.4, 0, H * 0.008, H * 0.01, H - (by + H * 0.4), C.dark, 5);
      m.block(L * 0.44, by, 0, L * 0.03, H * 0.05, B * 0.4, C.concreteDark); // forecastle
    }}
  />
);
