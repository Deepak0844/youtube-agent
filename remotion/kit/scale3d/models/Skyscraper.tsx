import React from "react";
import { Built, C, GlassBox } from "./geo";

const FLOOR = 4;
const tiers = (H: number) => {
  const W = H * 0.24;
  return [
    { w: W, h: Math.round((H * 0.6) / FLOOR) * FLOOR },
    { w: W * 0.78, h: Math.round((H * 0.22) / FLOOR) * FLOOR },
    { w: W * 0.54, h: Math.round((H * 0.1) / FLOOR) * FLOOR },
  ];
};

/** Glass tower with three setbacks, a crown with plant rooms and a spire. Height is exact (spire included). */
export const Skyscraper: React.FC<{ height: number }> = ({ height: H }) => {
  const ts = tiers(H);
  const stack = ts.map((t, i) => ({ ...t, y0: ts.slice(0, i).reduce((a, q) => a + q.h, 0) }));
  const y = ts.reduce((a, q) => a + q.h, 0);
  const crown = H - y; // what is left for the plant room and spire
  const base = H * 0.012;
  return (
    <>
      {stack.map((t, i) => (
        <GlassBox key={i} w={t.w} h={t.h} d={t.w} y0={t.y0} floorH={FLOOR} bay={Math.max(3.6, H / 60)} tint={i === 1 ? "#f2f7fb" : "#ffffff"} />
      ))}
      <Built
        deps={[H]}
        build={(m) => {
          const top = stack[stack.length - 1]!;
          m.block(0, 0, 0, ts[0]!.w * 1.12, base, ts[0]!.w * 1.12, C.concrete); // podium plinth
          for (const t of stack) m.block(0, t.y0 + t.h, 0, t.w * 1.03, FLOOR * 0.3, t.w * 1.03, C.white); // setback parapets
          m.block(0, y, 0, top.w * 0.6, crown * 0.35, top.w * 0.6, C.concreteDark);
          m.block(top.w * 0.12, y + crown * 0.35, 0, top.w * 0.18, crown * 0.12, top.w * 0.18, C.white);
          m.cyl(0, y + crown * 0.35, 0, H * 0.0015, H * 0.006, crown * 0.65, C.dark, 6); // spire
        }}
      />
    </>
  );
};

/** Lower floors finished and glazed, upper floors still bare slabs and columns around a concrete core. */
export const HalfBuiltTower: React.FC<{ height: number }> = ({ height: H }) => {
  const W = H * 0.26;
  const done = Math.round((H * 0.55) / FLOOR) * FLOOR;
  const open = H - done;
  return (
    <>
      <GlassBox w={W} h={done} d={W} floorH={FLOOR} bay={Math.max(3.6, H / 60)} />
      <Built
        deps={[H]}
        build={(m) => {
          m.block(0, 0, 0, W * 1.1, H * 0.01, W * 1.1, C.concrete);
          const n = Math.floor(open / FLOOR);
          for (let i = 0; i <= n; i++) m.block(0, done + i * FLOOR, 0, W * 1.02, FLOOR * 0.1, W * 1.02, C.concrete);
          for (const x of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
            if (x === 0 && z === 0) continue;
            m.block(x * W * 0.45, done, z * W * 0.45, W * 0.05, n * FLOOR, W * 0.05, C.concreteDark);
          }
          m.block(0, done, 0, W * 0.3, n * FLOOR + FLOOR * 0.5, W * 0.3, C.concreteDark); // core runs ahead of the floors
          for (const x of [-1, 1]) for (const z of [-1, 1]) m.block(x * W * 0.45, done + n * FLOOR, z * W * 0.45, W * 0.012, FLOOR * 0.9, W * 0.012, C.red); // rebar
        }}
      />
    </>
  );
};
