import { AbsoluteFill } from "remotion";
import { Anim, Camera, LinGrad, Ov, Scene, Show, Shake, ToonFilm, useToon, clamp, eio, eout, lerp } from "yt-toon/core";
import { Burst, PopIn, Skyline, Streetlight } from "yt-toon/fx";
import { P, Puppet, mix } from "yt-toon/comic";

// Where does your ₹20 go? A UPI payment as a comic short (cartoon-shorts, comic style). Every time is a beat mark (B0..B13) or a scene id.
export const meta = { durationInFrames: 1243, fps: 30, width: 1080, height: 1920 };

const OL = "#17111b";
const pose = (...ps: object[]) => Object.assign({}, ...ps);
const blink = (t: number) => (((t + 0.4) % 3.3) < 0.09 ? 1 : 0);

// the cast: original characters
const CUST = { skin: "#b07a52", skinD: "#8a5a38", hair: "#1c1412", hairStyle: "short", top: "suit", shirt: "#33415c", shirtD: "#222c40", tie: "#e8343d", trim: "#fbf3e4", num: null, legs: "pants", pants: "#2a3146", shoe: "#3b2a20", shoeD: "#24180f", sock: null };
const SELLER = { skin: "#9c6644", skinD: "#7a4c30", hair: "#2a1a12", hairStyle: "short", beard: true, cap: "#d8574a", capD: "#a83a30", top: "tee", shirt: "#f0a33a", shirtD: "#c9822a", trim: "#fbf3e4", num: null, legs: "pants", pants: "#5a4030", shoe: "#2a1d16", shoeD: "#1a120e", sock: null };

const Phone = ({ screen }: { screen: string }) => (
  <g>
    <rect x={-22} y={-40} width={44} height={80} rx={9} fill="#1c2030" stroke={OL} strokeWidth={5} />
    <rect x={-16} y={-32} width={32} height={60} rx={4} fill={screen} />
  </g>
);

// counter, striped awning, CHAI sign, QR board, speaker box: the back part (behind the seller) and the front (covers his legs)
const StallBack = () => (
  <g>
    {Array.from({ length: 7 }, (_, k) => (
      <rect key={k} x={520 + k * 72} y={700} width={72} height={70} fill={k % 2 ? "#fbf3e4" : "#e8343d"} stroke={OL} strokeWidth={6} />
    ))}
    {[540, 1010].map((x) => (
      <rect key={x} x={x - 8} y={770} width={16} height={260} fill="#6a4a36" stroke={OL} strokeWidth={5} />
    ))}
    <circle cx={770} cy={808} r={14} fill="#ffe2a0" stroke={OL} strokeWidth={4} />
    <path d="M900 1000 q0 -70 50 -70 q50 0 50 70 z" fill="#b9b4aa" stroke={OL} strokeWidth={6} />
  </g>
);
const QR = [0, 1, 2, 3, 4, 5].flatMap((a) => [0, 1, 2, 3, 4, 5].map((b) => ((a * 7 + b * 3) % 5 < 2 || (a < 2 && b < 2) || (a > 3 && b < 2) || (a < 2 && b > 3) ? [a, b] : null))).filter((x): x is number[] => x !== null);
const StallFront = ({ lit }: { lit: boolean }) => (
  <g>
    <rect x={520} y={1020} width={520} height={270} rx={10} fill="#2f8f6a" stroke={OL} strokeWidth={8} />
    <rect x={505} y={995} width={550} height={36} rx={8} fill="#c98a5a" stroke={OL} strokeWidth={7} />
    <text x={780} y={1200} fontFamily="Bangers" fontSize={130} fill="#fbf3e4" textAnchor="middle" stroke={OL} strokeWidth={10} paintOrder="stroke">CHAI</text>
    <rect x={560} y={880} width={110} height={118} rx={8} fill="#fff" stroke={OL} strokeWidth={6} />
    {QR.map(([a, b]) => (
      <rect key={`${a}-${b}`} x={570 + a! * 15} y={892 + b! * 15} width={15} height={15} fill={OL} />
    ))}
    <rect x={700} y={930} width={80} height={66} rx={12} fill={lit ? "#ffd23f" : "#4a5068"} stroke={OL} strokeWidth={6} />
    {[0, 1, 2].map((k) => (
      <circle key={k} cx={722 + k * 18} cy={966} r={5} fill="#20232f" />
    ))}
  </g>
);
const Street = ({ sid }: { sid: string }) => (
  <>
    <LinGrad id={`${sid}-sky`} stops={[[0, "#3b2a6a"], [0.5, "#e0736a"], [0.75, "#ffb36a"], [1, "#3a2a40"]]} />
    <LinGrad id={`${sid}-road`} stops={[[0, "#4a3a4a"], [1, "#221a26"]]} />
    <rect x={-200} y={0} width={1480} height={1920} fill={`url(#${sid}-sky)`} />
    <Skyline x0={-100} x1={1180} base={1060} color="#5a3a6a" seed={6} hmin={200} hmax={520} lit="#ffd27a" />
    <rect x={-200} y={1060} width={1480} height={900} fill={`url(#${sid}-road)`} />
    <Streetlight x={150} y={1100} h={620} glow="#ffd27a" />
  </>
);
// a comic sound word: a burst that pops in (scene layer above the camera) and the word on top
const WordBurst = ({ word, x, y, rot, at, until, fill = "#ffd23f", size = 140 }: { word: string; x: number; y: number; rot: number; at: string; until: string; fill?: string; size?: number }) => (
  <Show from={at} to={until}>
    <PopIn at={at} dur={0.3} cx={x} cy={y}>
      <Burst cx={x} cy={y} r1={size * 0.75} r2={size * 1.25} n={12} fill={fill} stroke={OL} sw={9} seed={Math.round(x + y)} />
    </PopIn>
  </Show>
);
const WordText = ({ word, x, y, rot, at, until, size = 140 }: { word: string; x: number; y: number; rot: number; at: string; until: string; size?: number }) => (
  <Ov css={`left:${x - 400}px;width:800px;top:${y - size * 0.55}px;text-align:center;transform:rotate(${rot}deg);font-size:${size}px`} cls="word" enter={[{ preset: "slam", at }]} on={`${at}..${until}`}>
    {word}
  </Ov>
);

const Hook = () => {
  const { t, T } = useToon();
  const tap = T("B0%45");
  const paid = T("B0%75");
  const turn = T("B1");
  const lit = false;
  return (
    <Scene
      id="hook"
      tr="cut"
      above={
        <>
          <WordBurst word="PAID!" x={360} y={600} rot={-6} at="B0%75" until="B1" fill="#7fd18b" size={120} />
          <WordBurst word="?" x={560} y={470} rot={4} at="B1%30" until="hooke" size={150} />
        </>
      }
      overlays={
        <>
          <Ov css="left:0;right:120px;top:210px;text-align:center" enter={[{ preset: "slam", at: 0.1 }]}>
            <div className="title" style={{ fontSize: 230, color: "var(--gold)" }}>₹20</div>
            <div className="kicker" style={{ fontSize: 50 }}>one chai</div>
          </Ov>
          <WordText word="PAID!" x={360} y={600} rot={-6} at="B0%75" until="B1" size={120} />
          <WordText word="?" x={560} y={470} rot={4} at="B1%30" until="hooke" size={150} />
        </>
      }
    >
      <Camera a="hook" b="hooke" from={1} to={1.05} cx={540} cy={1000} />
      <Street sid="hook" />
      <Puppet
        options={SELLER}
        act={(tt) => ({ pose: pose(P.stand, { turn: 0.45, face: tt > paid ? "grin" : "smile", blink: blink(tt) }), x: 860, y: 1290, dir: -1, s: 1 })}
      />
      <StallBack />
      <StallFront lit={lit} />
      <Puppet
        options={CUST}
        act={(tt) => {
          const up = eout(clamp((tt - 0.05) / 0.45));
          let p = mix(P.stand, pose(P.point, { hand: "fist" }), up);
          p = pose(p, { face: tt > paid ? "grin" : "focus", blink: blink(tt + 1) });
          if (tt >= turn) p = mix(p, pose(P.hold, { turn: 0.8, face: "worry", hd: 10 }), eout(clamp((tt - turn) / 0.35)));
          return { pose: p, x: 330, y: 1290, dir: 1, s: 1 };
        }}
        held={[{ at: "hand", dx: 10, dy: -30, s: 1.15, r: (tt) => (tt >= turn ? -8 : 0), node: <Phone screen={t > paid ? "#7fd18b" : t > tap && t < tap + 0.15 ? "#ffffff" : "#9ad7ff"} /> }]}
      />
    </Scene>
  );
};

export default function Film() {
  return (
    <AbsoluteFill>
      <ToonFilm bg="#1b1630">
        <Hook />
      </ToonFilm>
    </AbsoluteFill>
  );
}
