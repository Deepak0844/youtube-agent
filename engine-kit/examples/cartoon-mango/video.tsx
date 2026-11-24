import { AbsoluteFill } from "remotion";
import { Camera, LinGrad, Ov, Scene, Show, ToonFilm, clamp, eio, eout, lerp, trf, useToon } from "yt-toon/core";
import { Skyline, Stars } from "yt-toon/fx";
import { Follow, P, Puppet, Tether, cycle, mix, pose } from "yt-toon/comic";

// A mango's journey from farm to shop, as a comic short (cartoon-shorts, comic style). Every time is a beat mark (B0..B13) or a scene id.
export const meta = { durationInFrames: 1226, fps: 30, width: 1080, height: 1920 };

const OL = "#17111b";
const blink = (t: number) => (((t + 0.4) % 3.3) < 0.09 ? 1 : 0);
const vis = (on: boolean) => (on ? undefined : { display: "none" as const });
const GREEN = [124, 192, 74];
const GOLD = [246, 185, 40];
const col = (k: number) => `rgb(${GREEN.map((g, i) => Math.round(lerp(g, GOLD[i]!, clamp(k)))).join(",")})`;

const FARMER = { skin: "#8a5a3c", skinD: "#6a3f28", hair: "#1c1412", hairStyle: "short", cap: "#e0b040", capD: "#b88a20", top: "tee", shirt: "#3aa37a", shirtD: "#2a7d5c", trim: "#fbf3e4", num: null, legs: "pants", pants: "#6a4a30", shoe: "#3b2a20", shoeD: "#24180f", sock: null, beard: true };
const WORKER = { skin: "#c58c62", skinD: "#9c6844", hair: "#3a2416", hairStyle: "puff", top: "tee", shirt: "#e8a23a", shirtD: "#c9822a", trim: "#fbf3e4", num: null, legs: "pants", pants: "#2a3146", sock: null };
const AGENT = { skin: "#b07a52", skinD: "#8a5a38", hair: "#1c1412", hairStyle: "bald", top: "shirt", shirt: "#e8343d", shirtD: "#b5222b", trim: "#fbf3e4", num: null, legs: "pants", pants: "#2a3146", glasses: "#17111b", sock: null };
const BUYER = { skin: "#d6a27a", skinD: "#b07e58", hair: "#1c1412", hairStyle: "short", top: "polo", shirt: "#4f7fd0", shirtD: "#3a5fa8", trim: "#fbf3e4", num: null, legs: "pants", pants: "#22293d", sock: null };
const KEEPER = { skin: "#9c6644", skinD: "#7a4c30", hair: "#2a1a12", hairStyle: "short", top: "tee", shirt: "#f0a33a", shirtD: "#c9822a", trim: "#fbf3e4", num: null, legs: "pants", pants: "#5a4030", sock: null, beard: true };
const CUST = { skin: "#c58c62", skinD: "#9c6844", hair: "#1c1412", hairStyle: "puff", top: "tee", shirt: "#8c5ad0", shirtD: "#6a40a8", trim: "#fbf3e4", num: null, legs: "pants", pants: "#2a3146", sock: null };

const Txt = ({ s, x, y, size, fill = "#fff", font = "Anton", outline }: { s: string; x: number; y: number; size: number; fill?: string; font?: string; outline?: number }) => (
  <text x={x} y={y} fontFamily={font} fontSize={size} fill={fill} textAnchor="middle" stroke={outline ? OL : undefined} strokeWidth={outline} paintOrder={outline ? "stroke" : undefined}>{s}</text>
);
const Sky = ({ id, stops }: { id: string; stops: [number, string][] }) => (
  <>
    <LinGrad id={id} stops={stops} />
    <rect x={-200} y={0} width={1480} height={1920} fill={`url(#${id})`} />
  </>
);
const Ground = ({ id, y, stops }: { id: string; y: number; stops: [number, string][] }) => (
  <>
    <LinGrad id={id} stops={stops} />
    <rect x={-200} y={y} width={1480} height={900} fill={`url(#${id})`} />
  </>
);
const MangoShape = ({ fill, children }: { fill: string; children?: React.ReactNode }) => (
  <>
    <path d="M-30 0 C-30 -26 -6 -36 14 -28 C34 -20 36 6 22 22 C8 36 -30 30 -30 0 Z" fill={fill} stroke={OL} strokeWidth={6} />
    <path d="M10 -30 q6 -14 18 -16" fill="none" stroke="#5a3a1a" strokeWidth={5} strokeLinecap="round" />
    <ellipse cx={-10} cy={-12} rx={7} ry={4} fill="#fff" opacity={0.55} />
    {children}
  </>
);
const Mango = ({ x, y, s = 1, r = 0, fill = col(0), style }: { x: number; y: number; s?: number; r?: number; fill?: string; style?: React.CSSProperties }) => (
  <g transform={trf(x, y, s, r)} style={style}>
    <MangoShape fill={fill} />
  </g>
);
const Crate = ({ x, y, fills, style, children }: { x: number; y: number; fills?: string[]; style?: React.CSSProperties; children?: React.ReactNode }) => (
  <g transform={trf(x, y, 1, 0)} style={style}>
    <rect x={-90} y={-50} width={180} height={90} rx={8} fill="#c9925a" stroke={OL} strokeWidth={7} />
    {[-20, 10].map((dy) => (
      <line key={dy} x1={-84} y1={dy} x2={84} y2={dy} stroke="#a8743f" strokeWidth={6} />
    ))}
    {[-55, 0, 55].map((dx, i) => (
      <Mango key={dx} x={dx} y={-66} s={0.75} fill={fills ? fills[i] : col(0)} />
    ))}
    {children}
  </g>
);
const Tree = ({ x, y, s }: { x: number; y: number; s: number }) => (
  <g transform={trf(x, y, s, 0)}>
    <path d="M-24 0 L-16 -240 L16 -240 L24 0 Z" fill="#7a5636" stroke={OL} strokeWidth={7} />
    {[[0, -330, 170, "#2f7a3a"], [-110, -270, 110, "#3f9a4a"], [110, -280, 110, "#3f9a4a"]].map(([cx, cy, r, c]) => (
      <circle key={`${cx}`} cx={cx as number} cy={cy as number} r={r as number} fill={c as string} stroke={OL} strokeWidth={7} />
    ))}
    {[[-90, -230], [60, -210], [120, -300], [-40, -380], [-130, -330]].map(([mx, my]) => (
      <Mango key={`${mx}`} x={mx!} y={my!} s={0.8} />
    ))}
  </g>
);
const PYRAMID = [[620, 975], [690, 975], [760, 975], [830, 975], [900, 975], [690, 923], [760, 923], [830, 923], [760, 871]];
const Basket = () => (
  <g transform={trf(230, 1270, 1, 0)}>
    <path d="M-90 -70 L90 -70 L70 20 L-70 20 Z" fill="#c98a5a" stroke={OL} strokeWidth={8} />
  </g>
);
// the farmer reaches up with a net pole: his arm and the pole follow `up` (0 hands down .. 1 reaching)
const farmerAct = (t: number, up: number, face: string) => ({ pose: pose(mix(P.stand, pose(P.reach, { nua: 150, nfa: 10 }), up), { turn: 0.55, face: face as "grin", blink: blink(t) }), x: 420, y: 1290, dir: 1 as const, s: 1 });
const poleEnd = (up: number, h: [number, number]): [number, number] => [lerp(h[0] + 60, 640, up), lerp(h[1] - 60, 820, up)];

// ---------------------------------------------------------------- orchard: picked by hand
const Orchard = () => {
  const { t, T } = useToon();
  const pick = T("B1%40");
  const drop = T("B1%75");
  const k = eio(clamp((t - pick) / (drop - pick)));
  const hp = t < pick ? [640, 830] : [lerp(640, 230, k), lerp(830, 1190, k) - 160 * Math.sin(Math.PI * k)];
  return (
    <Scene
      id="orchard"
      tr="cut"
      words={[{ word: "PLOP!", x: 300, y: 980, rot: -6, at: "B1%75", until: "orcharde", fill: "#7fd18b", size: 120 }]}
      overlays={
        <Ov css="left:0;right:120px;top:200px;text-align:center" enter={[{ preset: "slam", at: 0.1 }]} during="0..B1">
          <div className="title" style={{ fontSize: 150, color: "var(--gold)" }}>FARM</div>
          <div className="kicker" style={{ fontSize: 46 }}>→ shop</div>
        </Ov>
      }
    >
      <Camera a="orchard" b="pack" from={1} to={1.05} cx={540} cy={1000} />
      <Sky id="orchard-sky" stops={[[0, "#7fc3ff"], [0.6, "#cfeaff"], [1, "#bfe39a"]]} />
      <Ground id="orchard-grass" y={1100} stops={[[0, "#8fcf5a"], [1, "#5a9a3a"]]} />
      <Tree x={160} y={1150} s={0.8} />
      <Tree x={700} y={1200} s={1.15} />
      <Puppet id="farmer" options={FARMER} act={(tt) => farmerAct(tt, eout(clamp((tt - 0.4) / 0.6)) * (1 - eio(clamp((tt - drop - 0.2) / 0.4))), tt > drop ? "grin" : "focus")} />
      <Tether of="farmer" to={(tt, h) => poleEnd(eout(clamp((tt - 0.4) / 0.6)) * (1 - eio(clamp((tt - drop - 0.2) / 0.4))), h)} stroke="#b98a5a" width={12} tip={{ r: 26, stroke: "#ffd23f", width: 8 }} />
      <Basket />
      <Mango x={hp[0]!} y={hp[1]!} s={1.4} r={t > pick && t < drop ? (t - pick) * 200 : 0} />
    </Scene>
  );
};

// ---------------------------------------------------------------- pack: S, M, L and crates
const BIN_POS = [[660, 1250], [800, 1250], [940, 1250]];
const Pack = () => {
  const { t, T } = useToon();
  const toss = ["B2%30", "B2%55", "B2%80"].map((m) => T(m));
  const sizes = [0.7, 0.9, 1.1];
  return (
    <Scene id="pack" tr="whip">
      <Camera a="pack" b="packe" from={1.03} to={1} cx={540} cy={1000} />
      <Sky id="pack-sky" stops={[[0, "#e9dcc4"], [1, "#c9b8a0"]]} />
      <rect x={120} y={190} width={840} height={110} rx={18} fill="#f4ecdc" stroke={OL} strokeWidth={8} />
      <Txt s="PACKHOUSE" x={540} y={280} size={90} fill="#3a2f40" />
      <rect x={-200} y={1150} width={1480} height={800} fill="#8a7a64" />
      <Puppet options={WORKER} act={(tt) => ({ pose: pose(toss.some((a) => tt > a - 0.3 && tt < a + 0.1) ? P.point : P.hold, { turn: 0.55, face: "smile", blink: blink(tt) }), x: 360, y: 1150, dir: 1, s: 0.95 })} />
      <rect x={80} y={1000} width={560} height={60} rx={10} fill="#8d9a8a" stroke={OL} strokeWidth={8} />
      {["S", "M", "L"].map((l, i) => (
        <g key={l} transform={trf(BIN_POS[i]![0]!, BIN_POS[i]![1]!, 1, 0)}>
          <rect x={-80} y={-110} width={160} height={120} rx={12} fill={["#d4eaff", "#ffe9c2", "#ffdbe6"][i]} stroke={OL} strokeWidth={8} />
          <Txt s={l} x={0} y={-20} size={90} fill="#17111b" />
        </g>
      ))}
      {sizes.map((s, i) => {
        const k = eio(clamp((t - toss[i]! + 0.4) / 0.5));
        return <Mango key={i} x={lerp(460, BIN_POS[i]![0]!, k)} y={lerp(900, BIN_POS[i]![1]! - 120, k) - 220 * Math.sin(Math.PI * k)} s={s} style={vis(t > toss[i]! - 0.4)} />;
      })}
      {[0, 1, 2].map((i) => {
        const a = T("B3") + i * 0.35;
        const k = eout(clamp((t - a) / 0.3));
        return <Crate key={i} x={220 + i * 200} y={lerp(1150, 1290, k) - (1 - k) * 200} style={vis(t >= a)} />;
      })}
    </Scene>
  );
};

// ---------------------------------------------------------------- truck: overnight to the mandi
const TruckScene = () => {
  const { t, T } = useToon();
  const go = T("truck");
  const stop = T("B5%60");
  const k = eio(clamp((t - go) / (stop - go)));
  const moving = k < 1 ? 1 : 0;
  return (
    <Scene id="truck" tr="zoom" words={[{ word: "VROOM!", x: 380, y: 860, rot: -6, at: "B4%20", until: "B5", fill: "#ff8a3d", size: 120 }]}>
      <Sky id="truck-sky" stops={[[0, "#070a1c"], [0.6, "#1a2550"], [1, "#0c1028"]]} />
      <Stars n={60} w={1080} h={700} seed={8} op={0.9} />
      <circle cx={830} cy={260} r={70} fill="#f3ecd0" />
      <circle cx={795} cy={238} r={70} fill="#0b1230" />
      <Show from="B5" to="trucke">
        <Skyline x0={400} x1={1180} base={1080} color="#1c2240" seed={6} hmin={200} hmax={480} lit="#ffd27a" />
        <rect x={560} y={620} width={380} height={110} rx={16} fill="#f4ecdc" stroke={OL} strokeWidth={8} />
        <Txt s="MANDI" x={750} y={710} size={90} fill="#3a2f40" />
      </Show>
      <LinGrad id="truck-road" stops={[[0, "#2c3348"], [1, "#141824"]]} />
      <rect x={-200} y={1080} width={1480} height={900} fill="url(#truck-road)" />
      <g transform={trf(-((t * 400) % 140) * moving, 0, 1, 0)}>
        {Array.from({ length: 12 }, (_, i) => (
          <rect key={i} x={i * 140} y={1230} width={80} height={14} fill="#ffd27a" />
        ))}
      </g>
      <g transform={trf(lerp(-300, 520, k), 1250 + 4 * Math.sin(t * 30) * moving, 1, 0)}>
        <rect x={-260} y={-230} width={360} height={210} rx={16} fill="#efe4cf" stroke={OL} strokeWidth={8} />
        <rect x={-260} y={-110} width={360} height={26} fill="#e2ae3a" />
        <path d="M100 -180 L200 -180 L250 -100 L250 -20 L100 -20 Z" fill="#3d6b59" stroke={OL} strokeWidth={8} />
        <rect x={140} y={-165} width={70} height={55} rx={6} fill="#9ad7ff" stroke={OL} strokeWidth={5} />
        {[-180, 170].map((x) => (
          <circle key={x} cx={x} cy={-10} r={42} fill="#17111b" stroke="#555" strokeWidth={8} />
        ))}
        {[-200, -120, -40].map((dx) => (
          <Mango key={dx} x={dx} y={-250} s={0.8} />
        ))}
        <path d="M250 -80 L560 -170 L560 40 Z" fill="#ffe9a8" opacity={0.25} />
      </g>
    </Scene>
  );
};

// ---------------------------------------------------------------- mandi: the auction
const Mandi = () => {
  const { t, T } = useToon();
  const sold = T("B7");
  return (
    <Scene
      id="mandi"
      tr="whip"
      words={[
        { word: "WHO BIDS?", x: 760, y: 600, rot: -4, at: "B6%20", until: "B7", size: 110 },
        { word: "SOLD!", x: 760, y: 820, rot: 6, at: "B7", until: "mandie", fill: "#ff6a5a", size: 170 },
      ]}
    >
      <Camera a="mandi" b="mandie" from={1} to={1.05} cx={540} cy={1000} />
      <Sky id="mandi-sky" stops={[[0, "#f2b58a"], [1, "#e9dcc4"]]} />
      <path d="M-100 520 L540 300 L1180 520 Z" fill="#b6886a" stroke={OL} strokeWidth={9} />
      <rect x={120} y={330} width={840} height={110} rx={18} fill="#f4ecdc" stroke={OL} strokeWidth={8} />
      <Txt s="MANDI" x={540} y={420} size={90} fill="#3a2f40" />
      <rect x={-200} y={1150} width={1480} height={800} fill="#a8937a" />
      {[0, 1].map((r) => [0, 1, 2].map((c) => <Crate key={`${r}${c}`} x={160 + c * 190} y={1150 - r * 120} />))}
      <Crate x={820} y={1180}>
        <rect x={-100} y={-60} width={200} height={110} rx={12} fill="none" stroke="#ffd23f" strokeWidth={12} style={vis(t >= sold)} />
      </Crate>
      <rect x={330} y={1100} width={220} height={190} rx={12} fill="#8a5a3a" stroke={OL} strokeWidth={8} />
      <Puppet
        options={AGENT}
        act={(tt) => {
          const shout = tt > T("B6") && tt < sold + 0.5;
          return { pose: pose(shout ? pose(P.point, { face: "shout", open: 0.6 }) : P.stand, { turn: 0.7, face: tt > sold ? "grin" : shout ? "shout" : "focus", blink: blink(tt) }), x: 440, y: 1100, dir: 1, s: 0.9 };
        }}
      />
      <Puppet options={BUYER} act={(tt) => ({ pose: pose(tt > T("B6%60") && tt < sold + 0.6 ? pose(P.reach, { nua: 160, nfa: 6 }) : P.stand, { turn: 0.6, face: tt > sold ? "grin" : "focus", blink: blink(tt + 1) }), x: 980, y: 1290, dir: -1, s: 1 })} />
    </Scene>
  );
};

// ---------------------------------------------------------------- ripen: ethylene, golden, carbide banned
const Ripen = () => {
  const { t, T } = useToon();
  const a = T("B8");
  const b = T("B9%50");
  const k = clamp((t - a) / (b - a));
  return (
    <Scene
      id="ripen"
      tr="flash"
      words={[
        { word: "GOLDEN!", x: 540, y: 600, rot: -5, at: "B9%50", until: "B10", size: 150 },
        { word: "BANNED!", x: 540, y: 1000, rot: 5, at: "B10%40", until: "ripene", fill: "#ff6a5a", size: 130 },
      ]}
    >
      <Camera a="ripen" b="ripene" from={1.04} to={1} cx={540} cy={1000} />
      <Sky id="ripen-sky" stops={[[0, "#1f3a36"], [1, "#2f4a44"]]} />
      <rect x={120} y={190} width={840} height={110} rx={18} fill="#eef0e2" stroke={OL} strokeWidth={8} />
      <Txt s="RIPENING ROOM" x={540} y={280} size={80} fill="#2a3a34" />
      <rect x={-200} y={1150} width={1480} height={800} fill="#3a4f48" />
      {[0, 1].map((r) => [0, 1, 2].map((c) => <Crate key={`${r}${c}`} x={220 + c * 300} y={1180 - r * 140} fills={[0, 1, 2].map((j) => col(k * 1.2 - (((r * 3 + c) + j) % 4) * 0.06))} />))}
      {Array.from({ length: 10 }, (_, i) => {
        const q = ((t - a) * 0.4 + i / 10) % 1;
        const on = t > a && t < T("B10");
        return <circle key={i} r={40} fill="#ffffff" cx={100 + q * 880} cy={900 - q * 300 + 40 * Math.sin(i * 2)} opacity={on ? 0.25 * Math.sin(Math.PI * q) : 0} />;
      })}
      <Show from="B10" to="ripene">
        <rect x={360} y={470} width={360} height={420} rx={30} fill="#9aa0aa" stroke={OL} strokeWidth={10} />
        <Txt s="CARBIDE" x={540} y={700} size={80} fill="#17111b" />
        <path d="M330 450 L750 910 M750 450 L330 910" stroke="#e8343d" strokeWidth={50} strokeLinecap="round" />
      </Show>
    </Scene>
  );
};

// ---------------------------------------------------------------- shop: the shelf and your hands
const Shop = () => {
  const { t, T } = useToon();
  const grab = T("B12%45");
  return (
    <Scene id="shop" tr="whip">
      <Camera a="shop" b="shope" from={1} to={1.05} cx={540} cy={1000} />
      <LinGrad id="shop-sky" stops={[[0, "#3b2a6a"], [0.5, "#e0736a"], [0.75, "#ffb36a"], [1, "#3a2a40"]]} />
      <LinGrad id="shop-road" stops={[[0, "#4a3a4a"], [1, "#221a26"]]} />
      <rect x={-200} y={0} width={1480} height={1920} fill="url(#shop-sky)" />
      <Skyline x0={-100} x1={1180} base={1060} color="#5a3a6a" seed={6} hmin={200} hmax={520} lit="#ffd27a" />
      <rect x={-200} y={1060} width={1480} height={900} fill="url(#shop-road)" />
      {Array.from({ length: 7 }, (_, k) => (
        <rect key={k} x={520 + k * 72} y={700} width={72} height={70} fill={k % 2 ? "#fbf3e4" : "#3aa37a"} stroke={OL} strokeWidth={6} />
      ))}
      {[540, 1010].map((x) => (
        <rect key={x} x={x - 8} y={770} width={16} height={260} fill="#6a4a36" stroke={OL} strokeWidth={5} />
      ))}
      <Puppet options={KEEPER} act={(tt) => ({ pose: pose(P.stand, { turn: 0.45, face: tt > grab ? "grin" : "smile", blink: blink(tt) }), x: 860, y: 1290, dir: -1, s: 1 })} />
      <g>
        <rect x={520} y={1020} width={520} height={270} rx={10} fill="#2f8f6a" stroke={OL} strokeWidth={8} />
        <rect x={505} y={995} width={550} height={36} rx={8} fill="#c98a5a" stroke={OL} strokeWidth={7} />
        <Txt s="MANGOES" x={780} y={1200} size={110} fill="#fbf3e4" font="Bangers" outline={10} />
        {PYRAMID.map(([x, y], i) => (
          <Mango key={i} x={x!} y={y!} s={0.9} fill={col(1)} style={i === PYRAMID.length - 1 ? vis(t < grab) : undefined} />
        ))}
      </g>
      <Puppet
        id="cust"
        options={CUST}
        act={(tt) => {
          const w = clamp((tt - T("shop")) / (T("B12") - T("shop")));
          const walking = w > 0 && w < 1;
          const p = walking ? pose(cycle((tt - T("shop")) * 9, 1, "walk"), { face: "smile" }) : tt > grab - 0.3 ? mix(P.stand, P.reach, eout(clamp((tt - grab + 0.3) / 0.3))) : P.stand;
          return { pose: pose(p, { turn: walking ? 0.2 : 0.6, face: tt > grab ? "grin" : "wow", blink: blink(tt + 1) }), x: lerp(-150, 360, eio(w)), y: 1290, dir: 1, s: 1 };
        }}
      />
      <Follow of="cust" place={(_tt, h) => [h[0] + 10, h[1] - 20, 1, 0]}>
        <Mango x={0} y={0} fill={col(1)} style={vis(t >= grab)} />
      </Follow>
    </Scene>
  );
};

// ---------------------------------------------------------------- big: one bite, and the next green mango
const Big = () => {
  const { t, T } = useToon();
  const cut = T("B13%50");
  const bt = T("B13%18");
  const drop = T("B13%88");
  const upB = eout(clamp((t - cut) / 0.4));
  const k = eio(clamp((t - drop + 0.5) / 0.5));
  return (
    <Scene
      id="big"
      tr="whip"
      words={[
        { word: "SLURP!", x: 700, y: 600, rot: 6, at: "B13%18", until: "B13%50", size: 130 },
        { word: "PLOP!", x: 300, y: 980, rot: -6, at: "B13%88", until: "bige", fill: "#7fd18b", size: 110 },
      ]}
      overlays={
        <Ov css="left:0;right:120px;top:190px;text-align:center" enter={[{ preset: "down", at: "B13%55" }]} during="B13%55..bige">
          <div className="title" style={{ fontSize: 180, color: "var(--gold)" }}>~40%</div>
          <div className="kicker" style={{ fontSize: 46 }}>of the world's mangoes grow in India</div>
        </Ov>
      }
    >
      <Show from="big" to="B13%50">
        <Sky id="big-sky" stops={[[0, "#3b2a6a"], [0.5, "#e0736a"], [1, "#ffb36a"]]} />
        <rect x={-200} y={1100} width={1480} height={900} fill="#3a2a40" />
        <Puppet
          id="eater"
          options={CUST}
          act={(tt) => ({ pose: pose(mix(P.stand, pose(P.hold, { nua: 70, nfa: 110 }), eout(clamp((tt - T("big")) / 0.5))), { turn: 0.8, face: tt > bt ? "grin" : "wow", open: tt > bt - 0.2 && tt < bt + 0.2 ? 0.6 : 0, blink: blink(tt) }), x: 420, y: 1300, dir: 1, s: 1.25 })}
        />
        <Follow of="eater" at="head" place={(_tt, h) => [h[0] + 70, h[1] + 40, 2, -20]}>
          <MangoShape fill={col(1)}>
            <path d="M18 -30 a16 16 0 0 0 20 22 a14 14 0 0 0 -6 24" fill="#ffd27a" stroke={OL} strokeWidth={5} style={vis(t > bt)} />
          </MangoShape>
        </Follow>
        {[0, 1, 2, 3, 4].map((i) => (
          <Follow key={i} of="eater" at="head" place={(tt, h) => [h[0] + 150 + i * 14, h[1] + 30 + clamp((tt - bt - i * 0.12) / 0.6) * 380, 1, 0]}>
            <ellipse rx={9} ry={13} fill="#ffc23a" stroke={OL} strokeWidth={3} style={vis(t > bt + i * 0.12 && clamp((t - bt - i * 0.12) / 0.6) < 1)} />
          </Follow>
        ))}
      </Show>
      <Show from="B13%50" to="bige">
        <Sky id="big-sky2" stops={[[0, "#7fc3ff"], [0.6, "#cfeaff"], [1, "#bfe39a"]]} />
        <Ground id="big-grass" y={1100} stops={[[0, "#8fcf5a"], [1, "#5a9a3a"]]} />
        <Tree x={700} y={1200} s={1.15} />
        <Puppet id="farmerB" options={FARMER} act={(tt) => farmerAct(tt, eout(clamp((tt - cut) / 0.4)), tt > drop ? "grin" : "focus")} />
        <Tether of="farmerB" to={(_tt, h) => poleEnd(upB, h)} stroke="#b98a5a" width={12} />
        <Basket />
        <Mango x={lerp(640, 230, k)} y={lerp(830, 1190, k) - 160 * Math.sin(Math.PI * k)} s={1.4} />
      </Show>
    </Scene>
  );
};

export default function Film() {
  return (
    <AbsoluteFill>
      <ToonFilm bg="#1b1630">
        <Orchard />
        <Pack />
        <TruckScene />
        <Mandi />
        <Ripen />
        <Shop />
        <Big />
      </ToonFilm>
    </AbsoluteFill>
  );
}
