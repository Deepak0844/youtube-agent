import { AbsoluteFill } from "remotion";
import { Camera, LinGrad, Ov, Scene, Show, ToonFilm, clamp, eio, eout, lerp, trf, useToon } from "yt-toon/core";
import { Skyline, Streaks } from "yt-toon/fx";
import { Follow, P, Puppet, Tether, cycle, pose } from "yt-toon/comic";

// How a map knows there's traffic, as a comic short (cartoon-shorts, comic style). Every time is a beat mark (B0..B12) or a scene id.
export const meta = { durationInFrames: 1135, fps: 30, width: 1080, height: 1920 };

const OL = "#17111b";
const GREEN = "#3ccf6e";
const ORANGE = "#ffa23a";
const RED = "#e8343d";
const DOT = "#4fb3ff";
const CARC = ["#e8343d", "#4fb3ff", "#ffd23f", "#7fd18b", "#c08aff", "#ff8a3d"];
const blink = (t: number) => (((t + 0.4) % 3.3) < 0.09 ? 1 : 0);
const vis = (on: boolean) => (on ? undefined : { display: "none" as const });

const COMM = { skin: "#b07a52", skinD: "#8a5a38", hair: "#1c1412", hairStyle: "short", top: "suit", shirt: "#33415c", shirtD: "#222c40", tie: "#e8343d", trim: "#fbf3e4", num: null, legs: "pants", pants: "#2a3146", sock: null };
const ARTIST = { skin: "#d6a27a", skinD: "#b07e58", hair: "#c9a04a", hairStyle: "puff", top: "tee", shirt: "#2f2f3a", shirtD: "#1c1c24", glasses: "#17111b", trim: "#fbf3e4", num: null, legs: "pants", pants: "#5a4a6a", sock: null };

const Txt = ({ s, x, y, size, fill = "#fff", font = "Anton" }: { s: string; x: number; y: number; size: number; fill?: string; font?: string }) => (
  <text x={x} y={y} fontFamily={font} fontSize={size} fill={fill} textAnchor="middle">{s}</text>
);
// side view, facing right
const Car = ({ x, y, s, fill }: { x: number; y: number; s: number; fill: string }) => (
  <g transform={trf(x, y, s, 0)}>
    <path d="M-110 0 L-110 -50 Q-104 -62 -90 -62 L-50 -62 L-25 -100 L45 -100 L75 -62 L100 -60 Q112 -58 112 -44 L112 0 Z" fill={fill} stroke={OL} strokeWidth={7} />
    <path d="M-18 -92 L40 -92 L64 -64 L-34 -64 Z" fill="#bfe3ff" stroke={OL} strokeWidth={5} />
    {[-62, 62].map((x2) => (
      <g key={x2}>
        <circle cx={x2} cy={4} r={24} fill="#17111b" />
        <circle cx={x2} cy={4} r={9} fill="#bbb" />
      </g>
    ))}
  </g>
);
// a phone showing a little map (no real app or logo)
const PhoneMap = ({ x, y, s, rot = 0, road, style }: { x: number; y: number; s: number; rot?: number; road: string; style?: React.CSSProperties }) => (
  <g transform={trf(x, y, s, rot)} style={style}>
    <rect x={-150} y={-260} width={300} height={520} rx={40} fill="#1c2030" stroke={OL} strokeWidth={10} />
    <rect x={-128} y={-224} width={256} height={450} rx={16} fill="#eef3e6" />
    <path d="M-128 60 L128 -60" stroke="#d8d2c6" strokeWidth={30} />
    <path d="M-128 -120 L128 140" stroke={road} strokeWidth={30} strokeLinecap="round" />
    <circle cx={0} cy={10} r={18} fill="#4fb3ff" stroke="#fff" strokeWidth={6} />
  </g>
);
const StreetBg = ({ sid, stops }: { sid: string; stops: [number, string][] }) => (
  <>
    <LinGrad id={sid} stops={stops} />
    <rect x={-200} y={0} width={1480} height={1920} fill={`url(#${sid})`} />
    <Skyline x0={-100} x1={1180} base={980} color="#3a2a5a" seed={7} hmin={220} hmax={560} lit="#ffd27a" />
    <rect x={-200} y={980} width={1480} height={940} fill="#3a3a4a" />
    <rect x={-200} y={980} width={1480} height={40} fill="#7a7a8a" />
    {Array.from({ length: 9 }, (_, k) => (
      <rect key={k} x={k * 150} y={1190} width={90} height={14} fill="#f0e6c8" />
    ))}
  </>
);
const Wagon = ({ x }: { x: number }) => (
  <g transform={trf(x - 300, 1270, 0.9, 0)}>
    <rect x={-170} y={-110} width={300} height={110} rx={12} fill="#c0452f" stroke={OL} strokeWidth={8} />
    {[0, 1, 2, 3, 4, 5].map((a) => [0, 1].map((b) => (
      <g key={`${a}${b}`}>
        <rect x={-158 + a * 46} y={-150 + b * 22} width={38} height={60} rx={6} fill="#1c2030" stroke={OL} strokeWidth={4} />
        <rect x={-152 + a * 46} y={-144 + b * 22} width={26} height={44} rx={3} fill="#9ad7ff" />
      </g>
    )))}
    {[-120, 90].map((x2) => (
      <circle key={x2} cx={x2} cy={10} r={26} fill="#17111b" />
    ))}
  </g>
);

// ---------------------------------------------------------------- hook: the map is red. who told it?
const Hook = () => {
  const { t, T } = useToon();
  return (
    <Scene
      id="hook"
      tr="cut"
      words={[{ word: "WHO TOLD IT?", x: 640, y: 560, rot: 4, at: "B1", until: "hooke", size: 110 }]}
      overlays={
        <Ov css="left:0;right:120px;top:220px;text-align:center" enter={[{ preset: "slam", at: "B0%30" }]} during="B0%30..B1">
          <div className="title" style={{ fontSize: 170, color: "var(--red)" }}>JAM!</div>
        </Ov>
      }
    >
      <Camera a="hook" b="hooke" from={1} to={1.06} cx={540} cy={1000} />
      <StreetBg sid="hook-bg" stops={[[0, "#3b2a6a"], [0.6, "#e0736a"], [1, "#ffb36a"]]} />
      {CARC.map((c, i) => (
        <Car key={i} x={80 + i * 210} y={1150 + (i % 2) * 120} s={0.95} fill={c} />
      ))}
      <Puppet id="man" options={COMM} act={(tt) => ({ pose: pose(P.hold, { turn: 0.7, face: tt > T("B1") ? "worry" : "focus", blink: blink(tt) }), x: 300, y: 1300, dir: 1, s: 1.05 })} />
      <Follow of="man" place={(_tt, h) => [h[0] + 170, h[1] - 40, 0.55, -6]}>
        <PhoneMap x={0} y={0} s={1} road={t > T("B0%30") ? RED : GREEN} />
      </Follow>
    </Scene>
  );
};

// ---------------------------------------------------------------- phones: anonymous dots with a speed
const Phones = () => {
  const { t, T } = useToon();
  const pos = [0, 1, 2, 3, 4].map((i) => {
    const x = (((t - T("phones")) * 260 + i * 260) % 1400) - 160;
    const y = 1150 + (i % 2) * 110;
    const a = T("B2%20") + i * 0.25;
    const u = clamp((t - a) / 0.7);
    return { x, y, a, u, mx: 200 + ((x + 160) / 1400) * 680, my: 415 - ((x + 160) / 1400) * 35 };
  });
  return (
    <Scene id="phones" tr="zoom">
      <Camera a="phones" b="phonese" from={1.02} to={1} cx={540} cy={900} />
      <StreetBg sid="phones-bg" stops={[[0, "#2a3a70"], [1, "#6a8ad0"]]} />
      {CARC.slice(0, 5).map((c, i) => (
        <Car key={i} x={pos[i]!.x} y={pos[i]!.y} s={0.9} fill={c} />
      ))}
      {pos.map((p, i) => (
        <circle key={i} r={22} fill={DOT} stroke="#fff" strokeWidth={6} cx={lerp(p.x, p.mx, eio(p.u))} cy={lerp(p.y - 140, p.my, eio(p.u))} style={vis(t > p.a && p.u < 1)} />
      ))}
      <g>
        <rect x={120} y={180} width={840} height={420} rx={30} fill="#eef3e6" stroke={OL} strokeWidth={10} />
        <path d="M170 420 L910 380" stroke="#d8d2c6" strokeWidth={46} strokeLinecap="round" />
        {pos.map((p, i) => (
          <circle key={i} r={16} fill={DOT} stroke="#fff" strokeWidth={5} cx={p.mx} cy={p.my} style={vis(p.u >= 1)} />
        ))}
      </g>
      <Show from="B3" to="phonese">
        <rect x={300} y={220} width={480} height={80} rx={40} fill="#17111b" />
        <Txt s="NO NAMES · JUST SPEED" x={540} y={276} size={44} fill="#fbf3e4" />
      </Show>
    </Scene>
  );
};

// ---------------------------------------------------------------- colors: fast green, slow orange, stuck red
const Colors = () => {
  const { t, T } = useToon();
  const c0 = T("colors");
  const l5 = T("B5");
  const l6 = T("B6");
  // how far the traffic has moved: frame by frame at 900 / 260 / 30 px per second
  const F = Math.floor(clamp((t - c0) * 30, 0, 210));
  const n1 = clamp(Math.ceil((l5 - c0) * 30), 0, F);
  const n2 = clamp(Math.ceil((l6 - c0) * 30), n1, F);
  const dist = (n1 * 900 + (n2 - n1) * 260 + (F - n2) * 30) / 30;
  const gap = t < l5 ? 360 : t < l6 ? 270 : 225;
  const band = t < l5 ? GREEN : t < l6 ? ORANGE : RED;
  return (
    <Scene
      id="colors"
      tr="whip"
      words={[{ word: "HONK!", x: 760, y: 760, rot: 6, at: "B6%30", until: "colorse", fill: "#ff6a5a", size: 120 }]}
      overlays={[
        ["GREEN", GREEN, "B4", "B5"],
        ["ORANGE", ORANGE, "B5", "B6"],
        ["RED", RED, "B6", "colorse"],
      ].map(([word, col, a, b]) => (
        <Ov key={word} css="left:0;right:120px;top:240px;text-align:center" enter={[{ preset: "slam", at: a! }]} during={`${a}..${b}`}>
          <div className="title" style={{ fontSize: 180, color: col }}>{word}</div>
        </Ov>
      ))}
    >
      <StreetBg sid="colors-bg" stops={[[0, "#7fc3ff"], [1, "#cfeaff"]]} />
      <rect x={-200} y={1000} width={1480} height={30} fill={band} />
      {CARC.map((c, i) => (
        <Car key={i} x={((dist + i * gap) % 1500) - 200} y={1150 + (i % 2) * 110} s={0.9} fill={c} />
      ))}
      <Streaks x0={0} x1={1080} y0={1060} y1={1260} n={18} color="#fff" a="colors" b="B5" speed={9} />
    </Scene>
  );
};

// ---------------------------------------------------------------- usual: compare with the usual, predict next
const Usual = () => {
  const { t, T } = useToon();
  return (
    <Scene id="usual" tr="zoom" words={[{ word: "SLOWER!", x: 820, y: 260, rot: 6, at: "B7%70", until: "B8", fill: "#ff6a5a", size: 100 }]}>
      <LinGrad id="usual-bg" stops={[[0, "#1d2550"], [1, "#3a2a6a"]]} />
      <rect x={0} y={0} width={1080} height={1920} fill="url(#usual-bg)" />
      <rect x={120} y={300} width={840} height={860} rx={40} fill="#fbf3e4" stroke={OL} strokeWidth={12} />
      <Txt s="THIS ROAD · 9 AM" x={540} y={420} size={70} fill="#17111b" />
      {[["USUAL", 520, "#9ad7ff", 200 * eout(clamp((t - T("B7%10")) / 0.5))], ["TODAY", 760, RED, 470 * eout(clamp((t - T("B7%45")) / 0.6))]].map(([l, y, c, w]) => (
        <g key={l as string}>
          <Txt s={l as string} x={260} y={(y as number) + 70} size={60} fill="#17111b" />
          <rect x={380} y={(y as number) + 10} width={520} height={90} rx={16} fill="#e2d6bf" stroke={OL} strokeWidth={6} />
          <rect x={380} y={(y as number) + 10} width={w as number} height={90} rx={16} fill={c as string} stroke={OL} strokeWidth={6} />
        </g>
      ))}
      <Txt s="minutes to cross" x={640} y={920} size={44} fill="#7a7468" font="Inter" />
      <Show from="B8" to="usuale">
        <path d="M300 1030 C 460 960 620 1100 800 1000" fill="none" stroke="#ff7a3d" strokeWidth={18} strokeDasharray="30 22" strokeLinecap="round" />
        <path d="M780 960 L840 1000 L770 1040 Z" fill="#ff7a3d" stroke={OL} strokeWidth={6} />
        <Txt s="NEXT 30 MIN" x={540} y={1110} size={56} fill="#17111b" />
      </Show>
    </Scene>
  );
};

// ---------------------------------------------------------------- twist: 99 phones in a wagon
const Twist = () => {
  const { t, T } = useToon();
  const x = lerp(380, 820, clamp((t - T("twist")) / (T("twiste") - T("twist"))));
  return (
    <Scene
      id="twist"
      tr="flash"
      words={[{ word: "JAM?!", x: 760, y: 1000, rot: -6, at: "B10%60", until: "twiste", fill: "#ff6a5a", size: 130 }]}
      overlays={
        <Ov css="left:0;right:120px;top:220px;text-align:center" enter={[{ preset: "slam", at: "B9%30" }]} during="B9%30..B10">
          <div className="title" style={{ fontSize: 200, color: "var(--gold)" }}>99</div>
          <div className="kicker" style={{ fontSize: 52 }}>phones in a wagon</div>
        </Ov>
      }
    >
      <Camera a="twist" b="twiste" from={1} to={1.05} cx={540} cy={1000} />
      <StreetBg sid="twist-bg" stops={[[0, "#4a5a90"], [1, "#c8d6f0"]]} />
      <Puppet
        id="artist"
        options={ARTIST}
        act={(tt) => ({ pose: pose(cycle((tt - T("twist")) * 5, 0.8, "walk"), { turn: 0.25, face: tt > T("B10%60") ? "grin" : "focus", fhand: "fist", fua: -40, ffa: 20 }), x: lerp(380, 820, clamp((tt - T("twist")) / (T("twiste") - T("twist")))), y: 1290, dir: 1, s: 0.95 })}
      />
      <Wagon x={x} />
      <Tether of="artist" at="fhand" to={() => [x - 180, 1200]} stroke="#3a2a20" width={10} />
      <PhoneMap x={250} y={600} s={0.85} road={t > T("B10%60") ? RED : GREEN} style={vis(t > T("B10"))} />
    </Scene>
  );
};

// ---------------------------------------------------------------- end: the jam was a wagon of phones
const End = () => {
  const { t, T } = useToon();
  const go = T("B12%25");
  const green = T("B12%60");
  const x = lerp(560, 1500, eio(clamp((t - go) / 1.2)));
  return (
    <Scene
      id="end"
      tr="whip"
      words={[
        { word: "BYE!", x: 640, y: 600, rot: -6, at: "B12", until: "B12%45", size: 100 },
        { word: "OH.", x: 360, y: 560, rot: 5, at: "B12%62", until: "ende", fill: "#3ccf6e", size: 110 },
      ]}
      overlays={
        <Ov css="left:0;right:120px;top:1020px;text-align:center" enter={[{ preset: "pop", at: "B12%65" }]} during="B12%65..ende">
          <div className="pill" style={{ fontSize: 44 }}>jam gone: the wagon left</div>
        </Ov>
      }
    >
      <StreetBg sid="end-bg" stops={[[0, "#4a5a90"], [1, "#c8d6f0"]]} />
      <Puppet
        options={COMM}
        act={(tt) => ({ pose: pose(tt > green ? pose(P.hold, { nua: 40, fua: 40, nfa: 90, ffa: 90 }) : P.hold, { turn: 0.7, face: tt < T("B12") ? "worry" : tt < green ? "wow" : "grin", blink: blink(tt + 1) }), x: 180, y: 1300, dir: 1, s: 1 })}
      />
      <Puppet
        id="artist"
        options={ARTIST}
        act={(tt) => {
          const xx = lerp(560, 1500, eio(clamp((tt - go) / 1.2)));
          const waving = tt > T("B12") - 0.2 && tt < go + 0.2;
          return { pose: pose(waving ? pose(P.reach, { nua: 160, nfa: 20, turn: 0.9 }) : cycle((tt - T("end")) * 6, 0.8, "walk"), { turn: waving ? 0.9 : 0.25, face: "grin", fhand: "fist", fua: -40, ffa: 20, blink: blink(tt) }), x: xx, y: 1290, dir: 1, s: 0.95 };
        }}
      />
      <Wagon x={x} />
      <Tether of="artist" at="fhand" to={() => [x - 180, 1200]} stroke="#3a2a20" width={10} />
      <PhoneMap x={760} y={560} s={0.85} road={t > green ? GREEN : RED} />
    </Scene>
  );
};

export default function Film() {
  return (
    <AbsoluteFill>
      <ToonFilm bg="#1b1630">
        <Hook />
        <Phones />
        <Colors />
        <Usual />
        <Twist />
        <End />
      </ToonFilm>
    </AbsoluteFill>
  );
}
