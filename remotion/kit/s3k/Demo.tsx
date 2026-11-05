// S3kDemo: the demo composition. Renders an example scene written only with the kit. Lazy-loaded by registry.tsx (three.js loads only here),
// rendered natively on the Mac GPU (npm run s3k:stills), never in the container.
import React from "react";
import { staticFile } from "remotion";
import { Stage } from "./Stage";
import { Captions } from "./Overlays";
import { idResolver } from "./models";
import { TUNNEL_CAPTIONS, TunnelScene } from "./examples/TunnelScene";
import type { S3kDemoProps } from "./meta";

// Catalogue ids are file names under assets3d/files/ (the host links that folder into the render's public dir).
const resolver = idResolver((id) => staticFile(`assets3d/files/${id}.glb`));

export const S3kDemo: React.FC<S3kDemoProps> = ({ example = "tunnel", finish = "full" }) => {
  void example;
  return (
    <Stage overlay={<Captions items={TUNNEL_CAPTIONS} />}>
      <TunnelScene resolver={resolver} finish={finish} />
    </Stage>
  );
};
