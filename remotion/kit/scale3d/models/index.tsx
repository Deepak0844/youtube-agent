import React from "react";
import { WIDTH_RATIO, type Placement } from "../../../../src/shared/scale3d/math";
import { ContactShadow, Surroundings } from "./Backdrop";
import { HouseRow } from "./HouseRow";
import { Mountain } from "./Mountain";
import { Person } from "./Person";
import { Ship } from "./Ship";
import { HalfBuiltTower, Skyscraper } from "./Skyscraper";
import { SmallCrane } from "./SmallCrane";
import { TowerCrane } from "./TowerCrane";
import { Tree } from "./Tree";

export { Clouds, Ground } from "./Backdrop";

/** One model from the fixed library, by kind. `load` (a tower crane only) is the height of what hangs from its hook. */
export const Model: React.FC<{ kind: string; height: number; load?: number }> = ({ kind, height, load }) => {
  switch (kind) {
    case "tower_crane": return <TowerCrane height={height} load={load} />;
    case "small_crane": return <SmallCrane height={height} />;
    case "skyscraper": return <Skyscraper height={height} />;
    case "half_built_tower": return <HalfBuiltTower height={height} />;
    case "house_row": return <HouseRow height={height} />;
    case "tree": return <Tree height={height} />;
    case "person": return <Person height={height} />;
    case "ship": return <Ship height={height} />;
    case "mountain": return <Mountain height={height} />;
    default: throw new Error(`Scale3D: no model for kind "${kind}"`);
  }
};

/** A placed object: the model, a contact shadow and street furniture (not for a load hanging on a hook). */
export const PlacedModel: React.FC<{ kind: string; p: Placement; load?: number }> = ({ kind, p, load }) => (
  <group position={[p.x, p.y, p.z]}>
    <Model kind={kind} height={p.height} load={load} />
    {p.carriedBy ? null : (
      <>
        <ContactShadow w={p.width} d={p.height * (WIDTH_RATIO[kind] ?? 0.5) * 0.6 + 4} />
        {kind === "mountain" || kind === "ship" || kind === "tree" ? null : <Surroundings width={p.width} depth={Math.min(p.height * 0.8, 40)} height={p.height} />}
      </>
    )}
  </group>
);
