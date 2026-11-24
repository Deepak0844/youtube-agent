import React from "react";
import paperFactory from "./upstream/paper.js";

// Internal: the two paper shadow filters every cut-paper layer uses (cartoon-shorts paper.js kit()). Each Scene of the paper style draws its own
// (ids carry the scene id): a filter defined inside a hidden (display:none) scene does not apply to the scene that is showing.
export const PaperFilters: React.FC<{ scene: string }> = ({ scene }) => (
  <>
    <filter id={`paper-cut-${scene}`} x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx={0} dy={7} stdDeviation={7} floodColor="#05070f" floodOpacity={0.55} />
    </filter>
    <filter id={`paper-cuts-${scene}`} x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx={0} dy={3} stdDeviation={3} floodColor="#05070f" floodOpacity={0.5} />
    </filter>
  </>
);

let tile: string | undefined;
/** The 512 px paper-grain tile as a data URL (made once, in the page; a canvas is needed). */
export function paperTileUrl(): string {
  if (!tile) {
    const w: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    paperFactory(w, document);
    tile = w.Paper.paperTile() as string;
  }
  return tile;
}
