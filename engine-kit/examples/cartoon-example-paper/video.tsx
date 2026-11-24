import { AbsoluteFill } from "remotion";
import { Scene, ToonFilm, clamp, eio, eout, useToon } from "yt-toon/core";
import { Card, Dust, Figure, GradRect, Glow, Layer, Profile, Rays, StarField, parallax, rng, ridge, thousands } from "yt-toon/paper";
import { Follow, P, cycle, mix, pose } from "yt-toon/comic";

// "The Last Night of the Lighthouse Keeper": the paper style example (cartoon-shorts, paper style).
//   lamp  (B0-B1): a cut-paper night seascape, the lighthouse lamp ignites and its beam sweeps the sea; paper title, night counter
//   last  (B2):    he climbs the tower stairs in a shaft of light, then a profile close-up as the great lens glows
//   shore (B3-B4): from the gallery, the whole village lights candles along the shore; he raises a hand
// Every scene is a stack of paper layers moved by a parallax camera. Moving things are redrawn from time.
export const meta = { durationInFrames: 457, fps: 30, width: 1080, height: 1920 };

const WARM = "#ffd97a";
const op = (x: number) => Math.round(clamp(x) * 1000) / 1000;
const rect = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// the keeper's look for the puppet rig: a cap, a beard, long trousers (all black under the silhouette filter)
const KEEPER = { cap: "#000", beard: true, legs: "pants", build: 1.1 };

// the caption zone: a soft dark band so the words always read
const BAND = [[0, "#05070f", 0], [0.35, "#05070f", 0.7], [1, "#05070f", 0.92]] as [number, string, number][];
const Band = () => (
  <GradRect y={1220} width={1080} height={700} stops={BAND} />
);
// sea: wavy paper strips from y0 down, rocking with t
const Sea = ({ t, y0, rows, gap, cols, seed }: { t: number; y0: number; rows: number; gap: number; cols: string[]; seed: number }) => (
  <>
    {[0, 1, 2, 3, 4, 5].map((i) => {
      const y = y0 + i * gap;
      const ph = i * 1.3;
      return i < rows ? <Layer key={i} pts={ridge(-80, 1160, 1960, (x) => y + 7 * Math.sin(x / 80 + t * 1.3 + ph) + 4 * Math.sin(x / 31 - t * 0.8), 40)} fill={cols[i % cols.length]} amp={2.5} seed={seed + i} small edge="rgba(200,220,255,.18)" /> : null;
    })}
  </>
);
// the lighthouse body (static): base at (x, y), 575 units tall at s = 1, the lamp at (x, y - 486 s)
const Lighthouse = ({ x, y, s }: { x: number; y: number; s: number }) => {
  const hw = (yy: number) => 62 - 20 * (-yy / 440);
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      {[0, 1, 2, 3, 4].map((i) => {
        const y0 = -i * 88;
        const y1 = -(i + 1) * 88;
        return <Layer key={i} pts={[[-hw(y0), y0], [hw(y0), y0], [hw(y1), y1], [-hw(y1), y1]]} fill="#888" amp={1.2} seed={20 + i} small edge="rgba(255,240,210,.25)" grad={i % 2 ? [[0, "#6e2a33"], [1, "#3a1520"]] : [[0, "#a59fa8"], [1, "#5c5868"]]} />;
      })}
      <path d="M -14 0 L -14 -46 Q 0 -60 14 -46 L 14 0 Z" fill="#0b1020" />
      <Layer pts={rect(-70, -452, 70, -440)} fill="#1b1d2c" amp={1} seed={26} small />
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
        <rect key={i} x={-64 + i * 16 - 1.5} y={-474} width={3} height={22} fill="#1b1d2c" />
      ))}
      <rect x={-70} y={-476} width={140} height={4} fill="#1b1d2c" />
      <Layer pts="M -50 -520 L 0 -572 L 50 -520 Z" fill="#2a1a22" small edge="rgba(255,217,122,.35)" />
      <circle cx={0} cy={-578} r={7} fill="#2a1a22" />
    </g>
  );
};
// the lamp room glass, lit 0..1 (drawn over the body every frame)
const Lamp = ({ x, y, s, lit, t }: { x: number; y: number; s: number; lit: number; t: number }) => {
  const ly = y - 486 * s;
  const fl = 0.92 + 0.08 * Math.sin(t * 9);
  return (
    <>
      <rect x={x - 40 * s} y={y - 520 * s} width={80 * s} height={68 * s} fill={lit > 0 ? "#ffe6a8" : "#20263a"} opacity={op(0.25 + 0.75 * lit)} />
      {[-20, 0, 20].map((dx) => (
        <rect key={dx} x={x + (dx - 1.5) * s} y={y - 520 * s} width={3 * s} height={68 * s} fill="#1b1d2c" />
      ))}
      {lit > 0 ? (
        <>
          <Glow x={x} y={ly} r={380 * s} color={WARM} op={0.9 * lit * fl} />
          <Glow x={x} y={ly} r={120 * s} color="#fff6dc" op={lit} />
        </>
      ) : null}
    </>
  );
};

// ================================================================ lamp: the beam over a paper sea
const SKY1 = [[0, "#070b1c"], [0.45, "#15204a"], [0.55, "#2b3160"], [1, "#0b1020"]] as [number, string][];
const LampScene = () => {
  const { t, T, prog } = useToon();
  const a = T("lamp");
  const push = eio(prog(t, "lamp", "lampe"));
  const cam = (d: number) => parallax(d, push, 800, 640, 0.12, [-30, 20]);
  const ang = 180 + 26 * Math.sin((t - a) * 1.1 - 0.6);
  const lit = clamp((t - 0.1) / 0.5);
  const ly = 1082 - 486 * 0.95;
  const k1 = clamp((t - T("B0%28")) / 0.45);
  const k2 = clamp((t - T("B1")) / 0.35);
  const n = Math.round(1 + 14609 * eio(prog(t, "B1", "B1e")));
  return (
    <Scene
      id="lamp"
      tr="cut"
      above={
        <>
          <Card k={k1} x0={120} y0={220} x1={960} y1={410} text="FORTY YEARS" size={104} seed={11} />
          {k2 > 0 ? <Card k={k2} x0={300} y0={450} x1={780} y1={530} text={`${thousands(n)} NIGHTS`} size={44} seed={12} rot={2} font="Anton" weight={400} ls={3} fill="#6e2a33" /> : null}
        </>
      }
    >
      <g transform={cam(6)}>
        <GradRect x={-200} y={-200} width={1480} height={2320} stops={SKY1} />
        <StarField n={90} seed={4} h={900} />
      </g>
      <g transform={cam(4)}>
        <Layer pts={ridge(-120, 560, 1060, (x) => 985 - 40 * Math.exp(-Math.pow((x - 160) / 180, 2)) - 10 * Math.sin(x / 50), 24)} fill="#1a2142" amp={2} seed={31} />
      </g>
      <g transform={cam(2.6)}>
        <Sea t={t} y0={1000} rows={6} gap={52} cols={["#1d2a55", "#18244a", "#142040", "#101a36"]} seed={40} />
        {lit > 0 ? <Glow x={800 + Math.cos((ang * Math.PI) / 180) * 520} y={1080} r={240} color={WARM} op={0.35 * lit} /> : null}
      </g>
      <g transform={cam(1.6)}>
        <Layer pts={[[470, 1400], [520, 1190], [600, 1120], [660, 1090], [720, 1080], [1160, 1070], [1160, 1400]]} fill="#10172c" amp={5} seed={51} grad={[[0, "#222a46"], [1, "#0a0f1e"]]} />
        <Lighthouse x={800} y={1082} s={0.95} />
        <Lamp x={800} y={1082} s={0.95} lit={lit} t={t} />
        {lit > 0 ? (
          <>
            <Rays x={800} y={ly} ang={ang} spread={9} len={1500} n={6} color="#ffe6a8" op={0.42 * lit} seed={3} />
            <Rays x={800} y={ly} ang={ang + 180} spread={9} len={500} n={4} color="#ffe6a8" op={0.25 * lit} seed={5} />
            <Dust n={34} box={[500, ly - 220, 560, 440]} color="#fff6d6" seed={6} op={0.55 * lit} size={2.6} />
          </>
        ) : null}
        <Figure look={KEEPER} rim={{ rim: WARM, dx: -2, dy: -2, glow: 1 }} act={() => ({ pose: pose(P.stand, { turn: 0.3 }), x: 852, y: 1082 - 440 * 0.95, dir: -1, s: 0.13 })} />
      </g>
      <g transform={cam(1)}>
        <Sea t={t} y0={1300} rows={3} gap={70} cols={["#0e1730", "#0b132a", "#081022"]} seed={60} />
        <Layer pts={[[-80, 1960], [-80, 1360], [90, 1320], [210, 1380], [330, 1460], [380, 1960]]} fill="#070b16" amp={6} seed={71} />
        <Layer pts={[[760, 1960], [840, 1450], [960, 1390], [1160, 1360], [1160, 1960]]} fill="#070b16" amp={6} seed={72} />
        <Band />
      </g>
    </Scene>
  );
};

// ================================================================ last: up the stairs, then the lens
const STAIRS = [[-80, 1960], [-80, 1400], [20, 1400], [120, 1400], [120, 1314], [120, 1314], [220, 1314], [220, 1228], [220, 1228], [320, 1228], [320, 1142], [320, 1142], [420, 1142], [420, 1056], [420, 1056], [520, 1056], [520, 970], [520, 970], [620, 970], [620, 884], [620, 884], [720, 884], [720, 798], [720, 798], [820, 798], [820, 712], [820, 712], [920, 712], [920, 626], [920, 626], [1020, 626], [1160, 626], [1160, 1960]];
const LENS = [[0, "#fff3c8"], [0.7, "#e8b860"], [1, "#8a5a2a"]] as [number, string][];
const LastScene = () => {
  const { t, T, prog } = useToon();
  const a = T("last");
  const CUT = T("B2%46");
  const shotA = t < CUT;
  const k = shotA ? prog(t, "last", "B2%46") : clamp((t - CUT) / (T("laste") - CUT));
  const push = eio(k);
  const cam = (d: number) => (shotA ? parallax(d, push, 540, 700, 0.1, [-40, 60]) : parallax(d, push, 400, 820, 0.14, [20, 0]));
  const lit = clamp((t - T("B2%58")) / 0.4);
  const fl = 0.94 + 0.06 * Math.sin(t * 8);
  return (
    <Scene id="last" tr="zoom" above={<Card k={clamp((t - T("B2%70")) / 0.4)} x0={160} y0={220} x1={920} y1={400} text="LAST NIGHT" size={104} seed={13} italic rot={2} />}>
      <g transform={cam(3)}>
        <g style={shotA ? undefined : { display: "none" }}>
          <GradRect x={-200} y={-200} width={1480} height={2320} stops={[[0, "#2a2a40"], [0.5, "#151a2e"], [1, "#080b16"]]} />
          <Layer pts="M 150 520 L 150 330 Q 200 250 250 330 L 250 520 Z" fill="#22305e" grad={[[0, "#3a4a80"], [1, "#18224a"]]} small />
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <Layer key={i} pts={rect(-40, 140 + i * 230, 1120, 150 + i * 230)} fill="#1c2236" amp={2} seed={100 + i} shadow={false} edge="rgba(255,240,210,.08)" />
          ))}
          <Glow x={760} y={160} r={640} color={WARM} op={0.75} />
          <Rays x={760} y={-80} ang={104} spread={34} len={1700} n={9} color="#ffe6a8" op={0.2} seed={7} />
        </g>
        <g style={shotA ? { display: "none" } : undefined}>
          <GradRect x={-200} y={-200} width={1480} height={2320} stops={[[0, "#0a0f24"], [0.5, "#1a2550"], [1, "#070b16"]]} />
          <Sea t={t} y0={980} rows={5} gap={60} cols={["#1d2a55", "#18244a", "#142040"]} seed={140} />
          {[80, 420, 760].map((x) => (
            <rect key={x} x={x} y={-200} width={26} height={2400} fill="#070a14" />
          ))}
          <rect x={-200} y={1240} width={1480} height={30} fill="#070a14" />
        </g>
      </g>
      <g transform={cam(1.8)}>
        <g style={shotA ? undefined : { display: "none" }}>
          <Layer pts={STAIRS} fill="#0f1426" amp={2} seed={120} grad={[[0, "#2a3048"], [1, "#0b0f1c"]]} step={22} />
          <path d="M -40 1150 L 1100 170" stroke="#0b0f1c" strokeWidth={10} strokeLinecap="round" fill="none" />
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
            <rect key={i} x={64 + i * 100} y={Math.round((1150 - (104 + i * 100) * 0.86) * 10) / 10} width={6} height={250} fill="#0b0f1c" />
          ))}
          <Figure
            look={KEEPER}
            rim={{ rim: WARM, dx: 0, dy: -4, glow: 1.8 }}
            act={(tt) => {
              const kk = clamp((tt - a) / (CUT - a));
              const x = 160 + 420 * kk;
              const cyc = cycle((tt - a) * 7, 1, "walk");
              const p = pose(pose(P.stand, cyc), { tor: 12, hd: -6, nth: (cyc.nth ?? 0) + 22, fth: (cyc.fth ?? 0) + 22, nsh: (cyc.nsh ?? 0) - 26, fsh: (cyc.fsh ?? 0) - 26, turn: 0.25 });
              return { pose: p, x, y: 1400 - (x - 20) * 0.86 + 10, dir: 1, s: 0.78 };
            }}
          />
          <Dust n={40} box={[420, 120, 700, 1100]} color="#fff6d6" seed={8} op={0.5} />
          <Band />
        </g>
        <g style={shotA ? { display: "none" } : undefined}>
          <Glow x={720} y={760} r={700} color={WARM} op={0.55 * lit * fl} />
          <radialGradient id="last-lens"><stop offset={0} stopColor="#fff3c8" /><stop offset={0.7} stopColor="#e8b860" /><stop offset={1} stopColor="#8a5a2a" /></radialGradient>
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const r = 240 - i * 38;
            return <ellipse key={i} cx={860} cy={760} rx={r * 0.82} ry={r} fill="url(#last-lens)" opacity={op(0.35 + 0.6 * lit)} stroke="#5a3a1e" strokeWidth={3} />;
          })}
          <Glow x={720} y={760} r={200} color="#fff6dc" op={lit} />
          {lit > 0 ? <Rays x={720} y={760} ang={186} spread={46} len={1300} n={9} color="#ffe6a8" op={0.24 * lit} seed={9} /> : null}
          <Dust n={36} box={[260, 420, 640, 700]} color="#fff6d6" seed={4} op={0.55 * lit} />
        </g>
      </g>
      <g transform={cam(1)} style={shotA ? { display: "none" } : undefined}>
        <rect x={-40} y={1440} width={690} height={700} fill="#0b1020" />
        <Profile x={330} y={980} s={1.55} glint="#fff1c4" />
        <Band />
      </g>
    </Scene>
  );
};

// ================================================================ shore: the village answers
const SKY3 = [[0, "#070b1c"], [0.3, "#1a2148"], [0.42, "#3a3358"], [1, "#0b1020"]] as [number, string][];
const HOUSES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => {
  const x = 40 + i * 95 + (i % 3) * 12;
  const w = 64 + (i % 2) * 20;
  const h = 52 + ((i * 7) % 26);
  const y = 770 - 30 * Math.sin(x / 200) + (i % 2) * 14;
  return { x, y, w, h, lx: x + w / 2 - 8, ly: y - h + 14 };
});
// the villagers standing along the water: x, y, scale, facing (from a seeded random sequence)
const RF = rng(12);
const FOLK = Array.from({ length: 26 }, (_, i) => {
  const x = 30 + i * 40 + (RF() - 0.5) * 14;
  const y = 900 + 18 * Math.sin((30 + i * 40) / 300) + (RF() - 0.5) * 10;
  const sc = 0.1 + RF() * 0.03;
  const dir: 1 | -1 = RF() < 0.5 ? 1 : -1;
  return { x, y, sc, dir };
});
// light order: from the middle outwards, like a wave
const RANK = FOLK.map((p, i) => FOLK.filter((q, j) => Math.abs(q.x - 540) < Math.abs(p.x - 540) || (Math.abs(q.x - 540) === Math.abs(p.x - 540) && j < i)).length);
const Villagers = ({ t, c0, c1 }: { t: number; c0: number; c1: number }) => {
  const litAt = (i: number) => c0 + (c1 - c0) * 0.85 * (RANK[i]! / FOLK.length);
  const flick = (i: number) => 0.85 + 0.15 * Math.sin(t * 11 + i * 2.3);
  return (
    <>
      {FOLK.map((p, i) => {
        const k = clamp((t - litAt(i)) / 0.25);
        return k > 0 ? <ellipse key={i} cx={Math.round(p.x * 10) / 10} cy={Math.round((p.y + 110) * 10) / 10} rx={5} ry={46} fill="#ffd98a" opacity={op(0.28 * k * flick(i))} /> : null;
      })}
      {FOLK.map((p, i) => {
        const k = clamp((t - litAt(i)) / 0.25);
        return (
          <g key={i}>
            <Figure
              id={`f${i}`}
              rim={{ rim: k > 0 ? WARM : "#3a4470", dx: 0, dy: -2, glow: 1 }}
              act={(tt) => {
                const kk = clamp((tt - litAt(i)) / 0.25);
                return { pose: pose(P.stand, { turn: 0.5, nua: 6 + 40 * kk, nfa: 14 + 60 * kk, hd: 8 }), x: p.x, y: p.y, dir: p.dir, s: p.sc };
              }}
            />
            <Follow of={`f${i}`} place={(_tt, h) => [h[0], h[1], 1, 0]}>
              {k > 0 ? (
                <>
                  <Glow x={0} y={0} r={46} color={WARM} op={0.8 * k * flick(i)} />
                  <circle cx={0} cy={0} r={3} fill="#fff6dc" opacity={op(k)} />
                </>
              ) : null}
            </Follow>
          </g>
        );
      })}
    </>
  );
};
const ShoreScene = () => {
  const { t, T, prog } = useToon();
  const C0 = T("B3%22");
  const C1 = T("B3e");
  const push = eio(prog(t, "shore", "shoree"));
  const cam = (d: number) => parallax(d, push, 600, 900, 0.1, [-20, -30]);
  return (
    <Scene id="shore" tr="zoom" above={<Card k={clamp((t - T("B4+.2")) / 0.45)} x0={170} y0={220} x1={910} y1={400} text="THANK YOU" size={112} seed={14} />}>
      <g transform={cam(6)}>
        <GradRect x={-200} y={-200} width={1480} height={2320} stops={SKY3} />
        <StarField n={70} seed={8} h={560} rVar={2} opVar={0.5} opBase={0.2} />
        <Layer pts={ridge(-120, 1200, 1100, (x) => 640 - 50 * Math.sin(x / 260 + 1) - 12 * Math.sin(x / 70), 24)} fill="#1b2241" amp={2} seed={81} />
      </g>
      <g transform={cam(3)}>
        <Layer pts={ridge(-120, 1200, 1100, (x) => 760 - 30 * Math.sin(x / 200), 24)} fill="#232b4a" amp={2.5} seed={82} grad={[[0, "#2d3558"], [1, "#141a30"]]} />
        {HOUSES.map((h, i) => (
          <Layer key={i} pts={[[h.x, h.y], [h.x, h.y - h.h], [h.x + h.w / 2, h.y - h.h - 34], [h.x + h.w, h.y - h.h], [h.x + h.w, h.y]]} fill="#2f3554" amp={1.5} seed={90 + i} small grad={[[0, "#3c4368"], [1, "#232845"]]} />
        ))}
        {HOUSES.map((h, i) => {
          const k = clamp((t - C0 - 0.15 * i) / 0.3);
          return k > 0 ? (
            <g key={i}>
              <rect x={h.lx} y={h.ly} width={16} height={20} fill="#ffd98a" opacity={op(k)} />
              <Glow x={h.lx + 8} y={h.ly + 10} r={40} color={WARM} op={0.6 * k} />
            </g>
          ) : null;
        })}
      </g>
      <g transform={cam(2)}>
        <Layer pts={ridge(-120, 1200, 1960, (x) => 860 + 18 * Math.sin(x / 300), 24)} fill="#4a4458" amp={2.5} seed={83} grad={[[0, "#6a6070"], [1, "#3a3448"]]} />
        <Sea t={t} y0={940} rows={6} gap={50} cols={["#16224a", "#132042", "#101b3a", "#0d1732"]} seed={160} />
        <Villagers t={t} c0={C0} c1={C1} />
        <Dust n={Math.round(50 * clamp((t - C0) / (C1 - C0)))} box={[0, 560, 1080, 360]} color="#ffd98a" seed={9} up={34} op={0.6} size={2.4} />
      </g>
      <g transform={cam(1)}>
        <Rays x={90} y={-160} ang={30 + 24 * Math.sin((t - T("shore")) * 0.9)} spread={8} len={1700} n={5} color="#ffe6a8" op={0.2} seed={13} />
        <Glow x={120} y={-60} r={520} color={WARM} op={0.5} />
        <Figure
          look={KEEPER}
          rim={{ rim: WARM, dx: -4, dy: -4, glow: 1.8 }}
          act={(tt) => {
            const w = clamp((tt - T("B4")) / 0.5);
            const base = { tor: 6, hd: 20, nua: 22, nfa: 24, fua: 18, ffa: 28, turn: 0.2 };
            const wave = { tor: 0, hd: 4, nua: 126, nfa: 34 + 14 * Math.sin((tt - T("B4")) * 5), fua: 18, ffa: 28, turn: 0.2, hand: "open" as const };
            return { pose: mix(base, wave, eout(w)), x: 230, y: 1320, dir: 1, s: 1.2 };
          }}
        />
        <rect x={-200} y={1170} width={1480} height={16} fill="#080b16" />
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((i) => (
          <rect key={i} x={-40 + i * 74} y={1170} width={9} height={150} fill="#080b16" />
        ))}
        <Layer pts={rect(-120, 1310, 1200, 1980)} fill="#070a14" amp={3} seed={140} />
      </g>
    </Scene>
  );
};

export default function Film() {
  return (
    <AbsoluteFill>
      <ToonFilm>
        <LampScene />
        <LastScene />
        <ShoreScene />
      </ToonFilm>
    </AbsoluteFill>
  );
}
