// THE LAND RECLAMATION SCENE written ONLY with the kit (a second pattern to imitate, next to TunnelScene).
// New things to copy here: two shot styles in one rig (`frame` = fit a box into the portrait safe area, `at/look` = explicit pose),
// tilted strata (`tiltDeg`), a water block behind glass, and a sea that only exists BEHIND the cut (sea.zMax = 0), with a sand floor in front.
import React, { useMemo } from "react";
import { CutawayBox } from "../Cutaway";
import { CameraRig } from "../Rig";
import { Finish } from "../Finish";
import { World } from "../World";
import { useModels, type ModelInfo, type ModelResolver } from "../models";
import type { CaptionItem } from "../Overlays";
import type { RigShot } from "../framing";
import { S3K_EXAMPLES } from "../meta";
import { useT } from "../time";
import { buildBoats } from "./boats";
import { BED_Y, BOTTOM_Y, LAND_X0, LAND_Y, RECLAMATION_MODELS, SEA_X1, SEA_Y, WALL_X1, buildReclamation } from "./reclamation";

export const RECLAMATION_SECONDS = S3K_EXAMPLES.reclamation.seconds;
export const RECLAMATION_CAPTIONS: CaptionItem[] = [
  { from: 0.6, to: 4.4, text: "Builders pile a ring of rock." },
  { from: 5.0, to: 9.4, text: "Ships pour sand inside it." },
  { from: 10.0, to: 13.6, text: "New land rises. Then a city." },
];
const T = RECLAMATION_SECONDS;
export const RECLAMATION_SHOTS: RigShot[] = [
  { t: 0, frame: { box: { min: [LAND_X0, BOTTOM_Y, -2], max: [SEA_X1, 6, 2] }, yawDeg: 10, pitchDeg: 14, distanceMul: 1.05 } },
  { t: T * 0.45, at: [70, 20, 72], look: [28, 0, -26] },
  { t: T, frame: { box: { min: [LAND_X0, BED_Y, -90], max: [WALL_X1, 70, 0] }, yawDeg: -22, pitchDeg: 12, distanceMul: 1.0 } },
];
const FOCUS = { min: [-100, -45, -130] as [number, number, number], max: [100, 75, 10] as [number, number, number] };
const IDS = Object.values(RECLAMATION_MODELS);

const Content: React.FC<{ models: NonNullable<ReturnType<typeof useModels>>; finish: "full" | "fast" | "off" }> = ({ models, finish }) => {
  const t = useT();
  const parts = useMemo(() => ({
    rec: buildReclamation(models),
    boats: buildBoats(models, [{ id: RECLAMATION_MODELS.boat, size: 9, x: 75, z: -12, yaw: 0.6 }, { id: RECLAMATION_MODELS.boat, size: 7, x: 50, z: -60, yaw: -0.3 }], SEA_Y),
  }), [models]);
  parts.rec.update(t); parts.boats.update(t);
  return (
    <>
      <World preset="clear" focus={FOCUS} ground={{ y: BOTTOM_Y, kind: "sand", tile: 12, zMin: 0 }} sea={{ y: SEA_Y, zMax: 0, color: "#2fb8cf" }} />
      {/* sea bed under everything: tilted layers, gravel and sand; the cut face is the plane z = 0 */}
      <CutawayBox x0={LAND_X0} x1={SEA_X1} top={BED_Y} bottom={BOTTOM_Y} tiltDeg={7} tile={40} parapet={false} waterBlock={{ x0: WALL_X1 + 3, x1: SEA_X1, y0: BED_Y, y1: SEA_Y - 0.05, depth: 60 }} />
      <primitive object={parts.rec.root} />
      <primitive object={parts.boats.root} />
      <CameraRig shots={RECLAMATION_SHOTS} floor={LAND_Y + 1.5} />
      {finish === "off" ? null : <Finish mode={finish} />}
    </>
  );
};

export const ReclamationScene: React.FC<{ resolver: ModelResolver; info?: (id: string) => ModelInfo | undefined; finish?: "full" | "fast" | "off" }> = ({ resolver, info, finish = "full" }) => {
  const models = useModels(IDS, resolver, info);
  return models ? <Content models={models} finish={finish} /> : null;
};
