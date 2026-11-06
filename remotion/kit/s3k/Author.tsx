// S3kAuthor: the HOST wrapper of an AI-written scene (render-entry.mjs --scene3d-code, bundle entry s3k-author-index.ts).
// The scene file is untrusted: it is reached ONLY through the "s3k-scene" webpack alias (the staged, re-checked scene.tsx), and it
// gets the page (Stage), the captions, the model resolver, the beat times and the length from HERE, as props. It cannot draw its own
// page or captions and cannot point the model loader anywhere: the resolver below only knows the staged catalogue files in `models`.
import React, { useMemo } from "react";
import { staticFile } from "remotion";
// @ts-expect-error resolved only in the sandboxed native render (webpack alias to the staged, checked scene.tsx, see render-entry.mjs)
import Scene from "s3k-scene";
import { Stage } from "./Stage";
import { Captions } from "./Overlays";
import type { SceneBeat } from "./meta";
import type { ModelResolver } from "./models";
import { setHeroProbe } from "./Hero";

/** inputProps written by the host (props.json, validated again by render-entry.mjs). `models` maps a catalogue id to its staged file (models/<file>.glb). */
export type AuthorInput = {
  beats: SceneBeat[];
  captions: { from: number; to: number; text: string }[];
  durationS: number;
  models: Record<string, string>;
  frames: number;
  /** Preview pictures only (render-entry.mjs sets it after validating props.json): the <Hero> reports where it sits, as console lines the host reads. */
  probeHero?: boolean;
};

export const S3kAuthor: React.FC<AuthorInput> = ({ beats, captions, durationS, models, probeHero }) => {
  setHeroProbe(probeHero === true);
  const resolver = useMemo<ModelResolver>(
    () => ({ resolve: (ref) => ("catalog" in ref && Object.hasOwn(models, ref.catalog) ? { url: staticFile(models[ref.catalog]!) } : null) }),
    [models],
  );
  return (
    <Stage overlay={<Captions items={captions} />}>
      <Scene resolver={resolver} beats={beats} durationS={durationS} />
    </Stage>
  );
};
