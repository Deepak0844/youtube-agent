// THE WHOLE TUNNEL SCENE (the approved proof) written ONLY with the kit: this is the file a model-written scene.tsx should imitate.
// Order that matters: <World> first (sky, light, ground, sea), then the objects, <CameraRig>, and <Finish> LAST.
// Pattern for objects: build once in useMemo (never rebuild per frame), call `part.update(t)` every render with t from useT().
import React, { useMemo } from "react";
import { CutawayBox } from "../Cutaway";
import { CameraRig } from "../Rig";
import { Finish } from "../Finish";
import { World } from "../World";
import { farSkyline } from "../city";
import { glideTimes } from "../framing";
import { useModels, type ModelInfo, type ModelResolver } from "../models";
import type { CaptionItem } from "../Overlays";
import { S3K_EXAMPLES } from "../meta";
import { useT } from "../time";
import { buildBoats } from "./boats";
import { BOTTOM, SEA, TUNNEL_MODELS } from "./dims";
import { buildTunnel, tunnelHole } from "./lining";
import { buildStation } from "./station";
import { buildStreet } from "./street";
import { buildMachine } from "./tbm";
import { buildTrain } from "./train";

export const TUNNEL_SECONDS = S3K_EXAMPLES.tunnel.seconds;
/** The three caption beats of the tunnel story. */
export const TUNNEL_CAPTIONS: CaptionItem[] = [
  { from: 0.5, to: 6.0, text: "A giant machine digs below." },
  { from: 7.2, to: 12.6, text: "Rings of concrete line the tunnel." },
  { from: 14.2, to: 19.6, text: "Then a train glides under the street." },
];

// ONE continuous glide through three shots: close on the cutter, along the finished tunnel, then up and out over the sea.
const POS: [number, number, number][] = [[27, -5, 19], [20, -5, 30], [10, -3, 86], [-14, 12, 92], [-56, 38, 96]];
const LOOK: [number, number, number][] = [[-2.5, -11.5, 0], [-5, -11.5, -0.5], [-15, -10, -1], [-20, -8, -2], [-26, -6, -4]];
const SHOT_TIMES = glideTimes(POS.length, TUNNEL_SECONDS);
export const TUNNEL_SHOTS = POS.map((at, i) => ({ t: SHOT_TIMES[i]!, at, look: LOOK[i]! }));

/** The box the shots look at: the sun's shadow frustum is fitted to it. */
const FOCUS = { min: [-125, -62, -75] as [number, number, number], max: [35, 30, 45] as [number, number, number] };
const IDS = Object.values(TUNNEL_MODELS);

const Content: React.FC<{ models: NonNullable<ReturnType<typeof useModels>>; finish: "full" | "fast" | "off" }> = ({ models, finish }) => {
  const t = useT();
  const parts = useMemo(() => {
    const machine = buildMachine(), tunnel = buildTunnel(), train = buildTrain(), street = buildStreet(models);
    const boats = buildBoats(models, [
      { id: TUNNEL_MODELS.ship, size: 24, x: -30, z: 50, yaw: 0.5 }, { id: TUNNEL_MODELS.boat, size: 7, x: -6, z: 38, yaw: -0.4 },
      { id: TUNNEL_MODELS.boat, size: 6, x: -58, z: 58, yaw: 0.2 }, { id: TUNNEL_MODELS.ship, size: 16, x: 22, z: 70, yaw: -0.8 },
    ], SEA);
    return { machine, tunnel, train, street, boats, station: buildStation(models), skyline: farSkyline({ groundY: 0 }) };
  }, [models]);
  parts.machine.update(t); parts.train.update(t); parts.street.update(t); parts.boats.update(t);
  return (
    <>
      <World preset="haze" focus={FOCUS} ground={{ y: 0, zMax: 0 }} sea={{ y: SEA, zMin: 0, foamZ: 0 }} />
      <CutawayBox x0={-420} x1={420} bottom={BOTTOM} holes={[tunnelHole()]} />
      {[parts.skyline, parts.tunnel.root, parts.station.root, parts.machine.root, parts.street.root, parts.train.root, parts.boats.root].map((o) => <primitive key={o.uuid} object={o} />)}
      <CameraRig shots={TUNNEL_SHOTS} />
      {finish === "off" ? null : <Finish mode={finish} />}
    </>
  );
};

/** Loads the catalogue models through `resolver`, then draws the scene. */
export const TunnelScene: React.FC<{ resolver: ModelResolver; info?: (id: string) => ModelInfo | undefined; finish?: "full" | "fast" | "off" }> = ({ resolver, info, finish = "full" }) => {
  const models = useModels(IDS, resolver, info);
  return models ? <Content models={models} finish={finish} /> : null;
};
