// Bundle entry of an AI-written 3D scene render (render-entry.mjs --scene3d-code / --scene3d-code-stills). A SEPARATE entry on purpose:
// the registry (index.ts) and every other composition never import "s3k-scene", so untrusted scene code is only ever in THIS bundle,
// and this bundle contains nothing but the s3k kit and the one staged scene file (the alias is set by render-entry.mjs).
import React from "react";
import { Composition, registerRoot } from "remotion";
import { S3kAuthor, type AuthorInput } from "./s3k/Author";

const Root: React.FC = () => (
  <Composition
    id="s3k-author"
    component={S3kAuthor as React.FC<Record<string, unknown>>}
    durationInFrames={1}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ beats: [], captions: [], durationS: 1, models: {}, frames: 1 } as unknown as Record<string, unknown>}
    calculateMetadata={({ props }) => ({ durationInFrames: Number((props as unknown as AuthorInput).frames) })}
  />
);

registerRoot(Root);
