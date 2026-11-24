import { createContext, useContext } from "react";

// Internal (not importable by scenes): finding the pieces of a drawn scene in the page.
export const SceneContext = createContext<string | null>(null);
export const useSceneId = (): string => {
  const id = useContext(SceneContext);
  if (!id) throw new Error("this yt-toon component must be inside a <Scene>");
  return id;
};

/** The pieces of one scene, found in the page when needed (the scene's React nodes attach after their children ran). */
export function sceneParts(id: string) {
  const div = document.querySelector<HTMLElement>(`.scene[data-scene="${id}"]`);
  if (!div) throw new Error(`scene ${id} is not drawn`);
  const svg = div.querySelector(":scope > svg") as (SVGSVGElement & { defs?: Element }) | null;
  if (!svg) throw new Error(`scene ${id} has no drawing layer`);
  const defs = svg.querySelector(":scope > defs") as Element;
  svg.defs = defs; // cartoon-shorts' FX helpers look for svg.defs
  return { id, div, svg, defs, cam: svg.querySelector(":scope > g.cam") as SVGGElement };
}

