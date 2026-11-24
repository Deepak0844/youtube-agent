import { AbsoluteFill } from "remotion";
import { Camera, LinGrad, Ov, Scene, Shake, ToonFilm, clamp, eio, eout, lerp, trf, useToon } from "yt-toon/core";
import { P, Puppet, pose } from "yt-toon/comic";

// Docker, explained: a comic short (cartoon-shorts, comic style). Every time is a beat mark (B0..B11) or a scene id.
export const meta = { durationInFrames: 1123, fps: 30, width: 1080, height: 1920 };

const OL = "#17111b";
const blink = (t: number) => (((t + 0.4) % 3.3) < 0.09 ? 1 : 0);
const vis = (on: boolean) => (on ? undefined : { display: "none" as const });
// the legend of the film: one colour per layer, coral = the app and its container
const COL = { os: "#5B7DB1", run: "#3ccf9a", lib: "#ffd23f", app: "#ff7a5a", box: "#ff6a4a", bad: "#9aa0aa", kern: "#6dd3a8" };
const LAYERS: [string, string][] = [[COL.os, "OS"], [COL.run, "RUNTIME"], [COL.lib, "LIBS"], [COL.app, "APP"]];

const DEV = { skin: "#b07a52", skinD: "#8a5a38", hair: "#1c1412", hairStyle: "puff", top: "tee", shirt: "#7a4fd0", shirtD: "#5a36a0", glasses: "#17111b", trim: "#fbf3e4", num: null, legs: "pants", pants: "#2a3146", sock: null };
const OPS = { skin: "#8a5a3c", skinD: "#6a3f28", hair: "#1c1412", hairStyle: "short", beard: true, top: "polo", shirt: "#3aa37a", shirtD: "#2a7d5c", trim: "#fbf3e4", num: null, legs: "pants", pants: "#22293d", sock: null };

const Txt = ({ s, x, y, size, fill = "#fff", font = "Anton", start, weight }: { s: string; x: number; y: number; size: number; fill?: string; font?: string; start?: boolean; weight?: number }) => (
  <text x={x} y={y} fontFamily={font} fontSize={size} fill={fill} textAnchor={start ? "start" : "middle"} fontWeight={weight}>{s}</text>
);
const Block = ({ x, y, w, h, col, label, style }: { x: number; y: number; w: number; h: number; col: string; label?: string; style?: React.CSSProperties }) => (
  <g transform={trf(x, y, 1, 0)} style={style}>
    <rect x={-w / 2} y={-h} width={w} height={h} rx={10} fill={col} stroke={OL} strokeWidth={7} />
    {label ? <Txt s={label} x={0} y={-h / 2 + 16} size={44} fill="#17111b" /> : null}
  </g>
);
// OS / runtime / libs / app; `parts` moves or hides each layer
const Stack = ({ x, y, s = 1, labels = true, w = 300, parts, style }: { x: number; y: number; s?: number; labels?: boolean; w?: number; parts?: { y: number; show: boolean }[]; style?: React.CSSProperties }) => (
  <g transform={trf(x, y, s, 0)} style={style}>
    {LAYERS.map(([c, n], i) => (
      <Block key={i} x={0} y={parts ? parts[i]!.y : -i * 82} w={w - i * 24} h={82} col={c} label={labels ? n : ""} style={parts ? vis(parts[i]!.show) : undefined} />
    ))}
  </g>
);
const Container = ({ x, y, s = 1, style }: { x: number; y: number; s?: number; style?: React.CSSProperties }) => (
  <g transform={trf(x, y, s, 0)} style={style}>
    <rect x={-200} y={-260} width={400} height={260} rx={14} fill={COL.box} stroke={OL} strokeWidth={9} />
    {[1, 2, 3, 4, 5, 6, 7].map((k) => (
      <line key={k} x1={-200 + k * 50} y1={-244} x2={-200 + k * 50} y2={-16} stroke="#c8452f" strokeWidth={8} />
    ))}
    <rect x={-60} y={-150} width={120} height={44} rx={8} fill="#fbf3e4" stroke={OL} strokeWidth={5} />
    <Txt s="APP" x={0} y={-116} size={34} fill="#17111b" />
  </g>
);
const Laptop = ({ x, y, s = 1 }: { x: number; y: number; s?: number }) => (
  <g transform={trf(x, y, s, 0)}>
    <path d="M-170 0 L170 0 L200 30 L-200 30 Z" fill="#c9ccd4" stroke={OL} strokeWidth={7} />
    <rect x={-150} y={-220} width={300} height={215} rx={12} fill="#3a3f4b" stroke={OL} strokeWidth={7} />
    <rect x={-130} y={-200} width={260} height={175} rx={6} fill="#9ad7ff" />
  </g>
);
const Rack = ({ x, y, s = 1, led }: { x: number; y: number; s?: number; led?: (i: number) => string }) => (
  <g transform={trf(x, y, s, 0)}>
    <rect x={-130} y={-520} width={260} height={520} rx={14} fill="#454150" stroke={OL} strokeWidth={8} />
    {[0, 1, 2, 3, 4, 5, 6].map((k) => (
      <g key={k}>
        <rect x={-100} y={-490 + k * 66} width={200} height={40} rx={6} fill="#2a2733" stroke={OL} strokeWidth={4} />
        <circle cx={70} cy={-470 + k * 66} r={9} fill={led ? led(k) : "#6dd3a8"} />
      </g>
    ))}
  </g>
);
const Badge = ({ x, y, ok, r = 60, style }: { x: number; y: number; ok: boolean; r?: number; style?: React.CSSProperties }) => (
  <g transform={trf(x, y, 1, 0)} style={style}>
    <circle r={r} fill={ok ? "#3ccf6e" : "#e8343d"} stroke={OL} strokeWidth={8} />
    <path d={ok ? `M${-r * 0.45} 0 L${-r * 0.1} ${r * 0.35} L${r * 0.5} ${-r * 0.35}` : `M${-r * 0.35} ${-r * 0.35} L${r * 0.35} ${r * 0.35} M${r * 0.35} ${-r * 0.35} L${-r * 0.35} ${r * 0.35}`} fill="none" stroke="#fff" strokeWidth={r * 0.22} strokeLinecap="round" strokeLinejoin="round" />
  </g>
);
const Room = ({ sid, a = "#1d2550", b = "#3a2a6a" }: { sid: string; a?: string; b?: string }) => (
  <>
    <LinGrad id={sid} stops={[[0, a], [1, b]]} />
    <rect x={-200} y={0} width={1480} height={1920} fill={`url(#${sid})`} />
    <rect x={-200} y={1290} width={1480} height={700} fill="#2a2440" />
  </>
);

// ---------------------------------------------------------------- hook: works on my machine, crashes on the server
const Hook = () => {
  const { t, T } = useToon();
  const crash = t >= T("B1%40");
  return (
    <Scene
      id="hook"
      tr="cut"
      words={[{ word: "CRASH!", x: 680, y: 470, rot: 6, at: "B1%40", until: "hooke", fill: "#ff6a5a", size: 115 }]}
      overlays={
        <Ov css="left:0;right:540px;top:300px;text-align:center" enter={[{ preset: "slam", at: "B0%40" }]} during="B0%40..B1%40">
          <div className="title" style={{ fontSize: 120, color: "var(--gold)" }}>WORKS!</div>
        </Ov>
      }
    >
      <Room sid="hook-bg" />
      <Puppet options={DEV} act={(tt) => ({ pose: pose(tt >= T("B1%40") ? pose(P.stand, { hd: 10 }) : P.celebrate, { turn: 0.7, face: tt >= T("B1%40") ? "wow" : "grin", blink: blink(tt) }), x: 150, y: 1300, dir: 1, s: 0.9 })} />
      <Laptop x={330} y={1180} s={0.9} />
      <rect x={120} y={1180} width={420} height={30} fill="#8a5a3a" stroke={OL} strokeWidth={6} />
      <Rack x={820} y={1290} s={0.9} led={(i) => (crash ? (Math.floor(t * 8 + i) % 2 ? "#e8343d" : "#4a1d1d") : "#6dd3a8")} />
      <Badge x={330} y={900} ok r={60} style={vis(t > T("B0%40"))} />
      <Badge x={820} y={720} ok={false} r={70} style={vis(crash)} />
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const u = ((t - T("B1%40")) * 0.5 + i / 6) % 1;
        return <circle key={i} r={40} fill="#9aa0aa" cx={820 + 40 * Math.sin(i * 2 + u * 3)} cy={760 - u * 400} opacity={crash ? 0.5 * (1 - u) : 0} />;
      })}
      <Shake at="B1%45" dur={0.4} amp={20} />
    </Scene>
  );
};

// ---------------------------------------------------------------- why: other OS, missing library
const Why = () => {
  const { t, T } = useToon();
  const w = Math.sin((t - T("why")) * 12) * 9 * clamp((t - T("why")) * 2);
  return (
    <Scene id="why" tr="zoom" words={[{ word: "MISSING!", x: 540, y: 620, rot: -5, at: "B2%55", until: "whye", size: 120 }]}>
      <Camera a="why" b="whye" from={1} to={1.06} cx={540} cy={1000} />
      <Room sid="why-bg" a="#2a1d3a" b="#4a2a4a" />
      <Block x={540} y={1250} w={360} h={90} col={COL.bad} label="OTHER OS" />
      <Block x={540} y={1160} w={330} h={90} col={COL.run} label="RUNTIME" />
      <rect x={390} y={980} width={300} height={90} rx={10} fill="none" stroke="#e8343d" strokeWidth={8} strokeDasharray="22 14" />
      <Txt s="LIBS?" x={540} y={1042} size={48} fill="#e8343d" />
      <g transform={trf(540 + w * 3, 975 + Math.abs(w), 1, w)}>
        <rect x={-135} y={-90} width={270} height={90} rx={10} fill={COL.app} stroke={OL} strokeWidth={7} />
        <Txt s="APP" x={0} y={-90 / 2 + 16} size={44} fill="#17111b" />
      </g>
    </Scene>
  );
};

// ---------------------------------------------------------------- pack: everything goes into one box
const PackScene = () => {
  const { t, T } = useToon();
  const a = T("B3%30");
  const b = T("B3%70");
  const k = eio(clamp((t - a) / (b - a)));
  return (
    <Scene id="pack" tr="whip" words={[{ word: "PACKED!", x: 560, y: 560, rot: -4, at: "B3%72", until: "packe", size: 130 }]}>
      <Room sid="pack-bg" />
      <Stack x={540} y={1250} style={vis(t < b)} />
      <Container x={540} y={lerp(-200, 1290, k)} s={1.25} />
      <Puppet options={DEV} act={(tt) => ({ pose: pose(tt < b ? P.point : P.celebrate, { turn: 0.7, face: "grin", blink: blink(tt) }), x: 150, y: 1300, dir: 1, s: 0.85 })} />
    </Scene>
  );
};

// ---------------------------------------------------------------- recipe: Dockerfile → image, layer by layer
const ROWS = ["FROM  base-os", "COPY  app", "RUN   install libs", "CMD   start app"];
const Recipe = () => {
  const { t, T } = useToon();
  const l5 = ["B5%15", "B5%40", "B5%65", "B5%85"].map((m) => T(m));
  const inPhase = t >= T("B5");
  const e = eio(clamp((t - T("B5")) / 0.4));
  return (
    <Scene
      id="recipe"
      tr="zoom"
      overlays={
        <Ov css="left:0;right:120px;top:260px;text-align:center" enter={[{ preset: "pop", at: "B5%88" }]} during="B5%88..recipee">
          <div className="pill" style={{ fontSize: 46 }}>IMAGE = read-only layers</div>
        </Ov>
      }
    >
      <Room sid="recipe-bg" a="#14304a" b="#1d4a5a" />
      <g transform={trf(inPhase ? lerp(540, 830, e) : 540, inPhase ? lerp(760, 520, e) : 760, inPhase ? lerp(0.95, 0.55, e) : 0.95, -3)}>
        <path d="M-200 -300 L200 -300 L200 260 L-200 260 Z" fill="#fbf3e4" stroke={OL} strokeWidth={9} />
        <Txt s="Dockerfile" x={0} y={-230} size={56} fill="#17111b" />
        {ROWS.map((r, i) => (
          <g key={i} style={vis(t > T("B4%20") + i * 0.3)}>
            <Txt s={r} x={-170} y={-140 + i * 80} size={40} fill="#2a2733" font="Inter" start weight={800} />
          </g>
        ))}
      </g>
      <Stack x={540} y={1290} w={320} parts={l5.map((a, i) => ({ y: -i * 82 - (1 - eout(clamp((t - a + 0.35) / 0.35))) * 600, show: t > a - 0.35 }))} />
    </Scene>
  );
};

// ---------------------------------------------------------------- ship: push to a registry, pull on a server, run
const Ship = () => {
  const { t, T } = useToon();
  const open = T("B8%20");
  const k1 = eio(clamp((t - T("B6%20")) / (T("B6e") - T("B6%20"))));
  const k2 = eio(clamp((t - T("B7%10")) / (T("B7e") - T("B7%10"))));
  const up = t < T("B7");
  const bx = up ? lerp(200, 550, k1) : lerp(550, 880, k2);
  const by = up ? lerp(1150, 560, k1) - 120 * Math.sin(Math.PI * k1) : lerp(560, 1120, k2) - 120 * Math.sin(Math.PI * k2);
  const win = t > T("B8%40");
  return (
    <Scene
      id="ship"
      tr="whip"
      words={[{ word: "SAME!", x: 560, y: 190, rot: 5, at: "B8%40", until: "shipe", fill: "#3ccf6e", size: 105 }]}
      overlays={
        <>
          <Ov css="left:0;right:600px;top:820px;text-align:center" enter={[{ preset: "pop", at: "B6%30" }]} during="B6%30..B7">
            <div className="pill" style={{ fontSize: 46 }}>PUSH ↑</div>
          </Ov>
          <Ov css="left:500px;right:0;top:820px;text-align:center" enter={[{ preset: "pop", at: "B7%20" }]} during="B7%20..B8">
            <div className="pill" style={{ fontSize: 46 }}>PULL ↓</div>
          </Ov>
        </>
      }
    >
      <Room sid="ship-bg" a="#5a7ab0" b="#c8d6f0" />
      <g>
        <path d="M220 520 Q220 380 380 380 Q420 280 560 300 Q700 260 760 380 Q880 380 880 520 Z" fill="#fbf3e4" stroke={OL} strokeWidth={9} />
        <Txt s="REGISTRY" x={550} y={480} size={64} fill="#5a3a8a" />
        {[0, 1, 2].map((i) => (
          <Container key={i} x={380 + i * 170} y={300} s={0.28} />
        ))}
      </g>
      <Laptop x={200} y={1260} s={0.7} />
      <Rack x={880} y={1290} s={0.8} />
      <Container x={bx} y={by} s={0.55} style={vis(t < open)} />
      <Puppet options={DEV} act={(tt) => ({ pose: pose(tt > T("B8%40") ? P.celebrate : P.point, { turn: 0.7, face: tt > T("B8%40") ? "grin" : "focus", blink: blink(tt) }), x: 330, y: 1300, dir: 1, s: 0.75 })} />
      <Puppet options={OPS} act={(tt) => ({ pose: pose(tt > T("B8%40") ? P.celebrate : P.stand, { turn: 0.7, face: tt > T("B8%40") ? "grin" : "wow", blink: blink(tt + 1) }), x: 650, y: 1300, dir: -1, s: 0.75 })} />
      <Badge x={880} y={780} ok r={60} style={vis(win)} />
      <Stack x={880} y={1110} s={0.75 * eout(clamp((t - open) / 0.3))} labels={false} w={200} style={vis(t >= open)} />
    </Scene>
  );
};

// ---------------------------------------------------------------- vm: a whole OS each vs one shared kernel
const Vm = () => {
  const { t, T } = useToon();
  return (
    <Scene
      id="vm"
      tr="flash"
      words={[
        { word: "HEAVY", x: 280, y: 600, rot: -6, at: "B9%40", until: "vme", fill: "#9aa0aa", size: 90 },
        { word: "LIGHT!", x: 800, y: 600, rot: 6, at: "B10%70", until: "vme", fill: "#3ccf6e", size: 100 },
      ]}
      overlays={
        <Ov css="left:0;right:120px;top:1270px;text-align:center" enter={[{ preset: "fade", at: "B10%70" }]} during="B10%70..vme">
          <div className="kicker" style={{ fontSize: 34 }}>counts are illustrative</div>
        </Ov>
      }
    >
      <Room sid="vm-bg" a="#1d2550" b="#2a1446" />
      <rect x={40} y={360} width={480} height={900} rx={24} fill="#fbf3e4" stroke={OL} strokeWidth={9} />
      <rect x={560} y={360} width={480} height={900} rx={24} fill="#fbf3e4" stroke={OL} strokeWidth={9} />
      <Txt s="VIRTUAL MACHINES" x={280} y={440} size={46} fill="#17111b" />
      <Txt s="CONTAINERS" x={800} y={440} size={46} fill="#17111b" />
      {[280, 800].map((x) => (
        <g key={x}>
          <Block x={x} y={1230} w={420} h={70} col="#5E5A68" label="HARDWARE" />
          <Block x={x} y={1160} w={400} h={70} col="#8A93A6" label="HOST OS" />
        </g>
      ))}
      {[0, 1, 2].map((i) => {
        const k = eout(clamp((t - T("vm") - 0.2 - i * 0.25) / 0.35));
        return (
          <g key={i} transform={trf(145 + i * 135, 1090 - (1 - k) * 500, 1, 0)} style={vis(k > 0)}>
            <Block x={0} y={0} w={120} h={200} col={COL.os} label="OS" />
            <Block x={0} y={-200} w={110} h={60} col={COL.lib} />
            <Block x={0} y={-260} w={100} h={60} col={COL.app} />
          </g>
        );
      })}
      <Block x={800} y={1090} w={400} h={60} col={COL.kern} label="SHARED KERNEL" style={vis(t > T("B10"))} />
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => {
        const k = eout(clamp((t - (T("B10%30") + i * 0.12)) / 0.3));
        return (
          <g key={i} transform={trf(680 + (i % 3) * 120, 1030 - Math.floor(i / 3) * 130 - (1 - k) * 300, 1, 0)} style={vis(k > 0)}>
            <Block x={0} y={0} w={100} h={50} col={COL.lib} />
            <Block x={0} y={-50} w={90} h={60} col={COL.app} />
          </g>
        );
      })}
    </Scene>
  );
};

// ---------------------------------------------------------------- end: "works on your machine?" then ship it
const DEST = [[190, 1050], [540, 900], [890, 930]];
const BUBBLE = { background: "#fff", border: "7px solid var(--ink)", borderRadius: 36, padding: "18px 30px", font: "400 64px/1.05 var(--comic)", color: "var(--ink)", boxShadow: "8px 10px 0 var(--ink)" };
const End = () => {
  const { t, T } = useToon();
  const fly = T("B11%62");
  return (
    <Scene
      id="end"
      tr="zoom"
      overlays={
        <>
          <Ov css="left:470px;right:60px;top:300px;text-align:center" enter={[{ preset: "pop", at: "B11" }]} during="B11..B11%45">
            <div style={BUBBLE}>WORKS ON <b style={{ color: "#e8343d" }}>YOUR</b> MACHINE?</div>
          </Ov>
          <Ov css="left:60px;right:500px;top:520px;text-align:center" enter={[{ preset: "pop", at: "B11%38" }]} during="B11%38..ende">
            <div style={BUBBLE}>THEN WE <b style={{ color: "#e8735a" }}>SHIP IT!</b></div>
          </Ov>
          <Ov css="left:0;right:120px;top:200px;text-align:center" enter={[{ preset: "pop", at: "B11%95" }]} during="B11%95..ende">
            <div className="pill" style={{ fontSize: 44 }}>laptop · server · cloud: same box</div>
          </Ov>
        </>
      }
    >
      <Room sid="end-bg" a="#14304a" b="#2a1446" />
      <Laptop x={190} y={1250} s={0.55} />
      <Rack x={540} y={1240} s={0.55} />
      <g transform={trf(880, 1040, 0.9, 0)}>
        <path d="M-150 40 Q-150 -60 -40 -60 Q-10 -130 80 -110 Q170 -120 180 -20 Q240 -10 230 40 Z" fill="#fbf3e4" stroke={OL} strokeWidth={8} />
        <Txt s="CLOUD" x={30} y={20} size={46} fill="#5a3a8a" />
      </g>
      {DEST.map(([x, y], i) => {
        const a = fly + i * 0.3;
        const k = eio(clamp((t - a) / 0.7));
        return <Container key={i} x={lerp(540, x!, k)} y={lerp(520, y!, k) - 220 * Math.sin(Math.PI * k)} s={0.32} style={vis(t > a)} />;
      })}
      {DEST.map(([x, y], i) => (
        <Badge key={i} x={x! + 90} y={y! - 120} ok r={40} style={vis(eio(clamp((t - (fly + i * 0.3)) / 0.7)) >= 1)} />
      ))}
      <Puppet options={DEV} act={(tt) => ({ pose: pose(tt > T("B11%35") ? P.point : P.stand, { turn: 0.7, face: tt > T("B11%35") ? "grin" : "focus", blink: blink(tt) }), x: 330, y: 1300, dir: 1, s: 0.62 })} />
      <Puppet options={OPS} act={(tt) => ({ pose: pose(tt > fly + 1.0 ? P.celebrate : P.stand, { turn: 0.7, face: tt < T("B11%35") ? "focus" : tt > fly + 1.0 ? "grin" : "wow", blink: blink(tt + 1) }), x: 760, y: 1300, dir: -1, s: 0.62 })} />
    </Scene>
  );
};

export default function Film() {
  return (
    <AbsoluteFill>
      <ToonFilm bg="#1b1630">
        <Hook />
        <Why />
        <PackScene />
        <Recipe />
        <Ship />
        <Vm />
        <End />
      </ToonFilm>
    </AbsoluteFill>
  );
}
