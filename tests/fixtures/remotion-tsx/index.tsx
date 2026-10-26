import React from "react";
import { Composition, registerRoot } from "remotion";
import { registry } from "./registry.gen";

function Root() {
  return <Composition id="scene" component={registry.Scene} width={1080} height={1920} fps={30} durationInFrames={60} />;
}

registerRoot(Root);
