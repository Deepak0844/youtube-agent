import { AbsoluteFill } from "remotion";
import { DotsPattern, FlashAt, Impact, LinGrad, Ov, RadGrad, Scene, Shake, Show, ToonFilm, clamp, useToon } from "yt-toon/core";
import { Sparkle, SpeedLines } from "yt-toon/anime";
import { Bust, ConfettiRain, Hatch, Sfx } from "yt-toon/manga";

// Manga style example: a small-town street cook vows to win the city's cooking contest, everyone laughs, he grins and wins.
// Original characters only. Three scenes (vow, laugh, win), every move keyed to a beat (B0..B4).
export const meta = { durationInFrames: 419, fps: 30, width: 1080, height: 1920 };

const INK = "#151214";
const back = (x0: number) => {
  const x = clamp(x0);
  return 1 + 2.9 * Math.pow(x - 1, 3) + 1.9 * Math.pow(x - 1, 2);
};

// cast: three original faces with contrasting heads, noses, hair and outfits
const COOK = { head: "lean", nose: "small", skin: "#f6c99c", skinS: "#dd9a68", hair: "#2a1a12", hairS: "#120a06", hairH: "#6e4a34", hairStyle: "spiky", eyeW: 56, eyeH: 30, eyeGap: 52, pupil: 12, mouthW: 1.05, outfit: "kit", shirt: "#f4f1e8", shirtS: "#c9c2b2", trim: "#2a7de1", headband: "#2a7de1" };
const JUDGE = { head: "square", nose: "long", skin: "#efc093", skinS: "#cf8d5a", hair: "#e2e4ea", hairS: "#959cab", hairH: "#ffffff", hairStyle: "swept", eyeW: 48, eyeH: 26, eyeGap: 54, pupil: 9, age: 1, glasses: true, frame: "#2a2226", outfit: "suit", suit: "#5a1e2e", suitS: "#3a111d", tie: "#ffc93c" };
const FAN = { head: "round", nose: "wide", skin: "#9a6644", skinS: "#74462c", blushC: "#d0604c", hair: "#1a120e", hairS: "#000", hairH: "#4f4038", hairStyle: "buzz", eyeW: 56, eyeH: 32, eyeGap: 52, pupil: 13, mouthW: 1.1, outfit: "kit", shirt: "#2f8f5b", shirtS: "#1f6a42", trim: "#ffc93c" };

// a full-frame radial burst
const Backdrop = ({ id, c0, c1, cx, cy }: { id: string; c0: string; c1: string; cx: number; cy: number }) => (
  <>
    <RadGrad id={id} stops={[[0, c0], [1, c1]]} cx={cx / 1080} cy={cy / 1920} r={0.75} />
    <rect width={1080} height={1920} fill={`url(#${id})`} />
  </>
);
const Wok = ({ x, y, s, t, fire }: { x: number; y: number; s: number; t: number; fire: boolean }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    {fire
      ? [0, 1, 2, 3, 4, 5, 6].map((i) => {
          const h = 115 + 45 * Math.sin(t * 13 + i * 1.7);
          const xx = -150 + i * 50;
          return <path key={i} d={`M ${xx - 34} 0 Q ${xx - 40} ${-h * 0.5} ${xx + 4} ${-h} Q ${xx + 10} ${-h * 0.5} ${xx + 34} 0 Z`} fill={i % 2 ? "#ffc93c" : "#ff6a2a"} stroke={INK} strokeWidth={4} />;
        })
      : null}
    <path d="M -200 -10 Q 0 120 200 -10 Z" fill="#2b2b33" stroke={INK} strokeWidth={7} strokeLinejoin="round" />
    <path d="M 196 -6 L 330 -40" stroke={INK} strokeWidth={18} strokeLinecap="round" />
    <path d="M -150 10 Q 0 40 150 10" fill="none" stroke="#6a6a78" strokeWidth={5} strokeLinecap="round" />
  </g>
);
// ---------------------------------------------------------------- vow: the stall at night, then the vow
const Vow = () => {
  const { t, T } = useToon();
  const after = (at: string, d = 0.3) => clamp((t - T(at)) / d);
  return (
    <Scene
      id="vow"
      tr="cut"
      overlays={
        <Ov css="left:0;right:0;top:200px;text-align:center;font-size:64px" cls="kicker" enter={[{ preset: "down", at: 0.15 }, { preset: "out", at: "B1-.15" }]} during="vow..B1">SMALL TOWN. BIG VOW.</Ov>
      }
    >
      <Show from="vow" to="B1">
        <LinGrad id="vow-night" stops={[[0, "#1d1b3a"], [0.6, "#5a2f4a"], [1, "#c4612f"]]} />
        <rect width={1080} height={1920} fill="url(#vow-night)" />
        <path d="M -20 330 Q 540 440 1100 330" fill="none" stroke={INK} strokeWidth={5} />
        {[0, 1, 2, 3, 4].map((i) => {
          const x = 120 + i * 210;
          const y = 345 + 90 * Math.sin((Math.PI * x) / 1080) * 0.9;
          return (
            <g key={i} transform={`translate(${x} ${y}) rotate(${(Math.sin(t * 2 + i) * 4).toFixed(1)})`}>
              <ellipse cx={0} cy={50} rx={44} ry={54} fill="#ff7a3a" stroke={INK} strokeWidth={5} />
              <path d="M -40 36 Q 0 44 40 36 M -42 64 Q 0 72 42 64" fill="none" stroke={INK} strokeWidth={3} />
              <ellipse cx={-12} cy={34} rx={10} ry={18} fill="#ffd9a0" opacity={0.8} />
            </g>
          );
        })}
        <Bust look={COOK} act={(tt) => ({ x: 440, y: 980 + Math.sin(tt * 2.4) * 4, s: 1.15, ex: { mouth: "smile", look: [0.7, 0.4], blush: 0.25, brow: 0.1 } })} />
        <path d="M -20 1220 L 1100 1220 L 1100 1940 L -20 1940 Z" fill="#8a4b2a" stroke={INK} strokeWidth={8} />
        <rect x={-20} y={1220} width={1120} height={34} fill="#b06a3c" stroke={INK} strokeWidth={6} />
        <Hatch d="M -20 1254 L 1100 1254 L 1100 1420 L -20 1420 Z" x0={-20} y0={1254} x1={1100} y1={1420} gap={12} ang={-40} w={3} op={0.5} />
        <Wok x={780} y={1200} s={0.9} t={t} fire={false} />
        {[0, 1, 2].map((i) => {
          const x = 720 + i * 60;
          const y = 1110 - ((t * 110 + i * 55) % 170);
          return <path key={i} d={`M ${x} ${y + 60} q -20 -20 0 -40 q 20 -20 0 -40`} fill="none" stroke="#fff" strokeWidth={8} strokeLinecap="round" opacity={0.75} />;
        })}
      </Show>
      <Show from="B1" to="vowe">
        <Backdrop id="vow-burst" c0="#ffb347" c1="#a3171c" cx={540} cy={820} />
        <SpeedLines cx={540} cy={820} r0={300} r1={1500} n={90} color="#fff3d6" op={0.6} seed={4} spin={12} />
        <DotsPattern id="vow-tone" color="#5a0d10" size={18} r={3} />
        <rect width={1080} height={1920} fill="url(#vow-tone)" opacity={0.25} />
        <Bust look={COOK} act={(tt) => ({ x: 540, y: 960, s: 1.05 + 0.2 * back(clamp((tt - T("B1")) / 0.3)), ex: { mouth: "shout", open: 0.9 + 0.1 * Math.sin(tt * 9), eyes: "fierce", brow: -0.2, tilt: -3 } })} />
        {t > T("B1%45") ? <Sfx x={540} y={470} text="DON!!" size={200 * back(after("B1%45", 0.25))} rot={-8} fill="#ffc93c" /> : null}
      </Show>
      <Shake at="B1" dur={0.35} amp={22} />
      <FlashAt at="B1" opacity={0.6} dur={0.2} />
      <Shake at="B1%45" dur={0.3} amp={16} />
    </Scene>
  );
};

// ---------------------------------------------------------------- laugh: two contrasting faces laugh, the cook sweats
const Laugh = () => {
  const { t, T } = useToon();
  const after = (at: string, d = 0.3) => clamp((t - T(at)) / d);
  const k = back(after("B2%35", 0.3));
  const pd = "M 640 1040 L 1000 1040 L 1000 1280 L 640 1280 Z";
  return (
    <Scene id="laugh" tr="whip">
      <rect width={1080} height={1920} fill="#fff1c9" />
      <DotsPattern id="laugh-tone" color="#e2667a" size={20} r={3.4} />
      <rect width={1080} height={1920} fill="url(#laugh-tone)" opacity={0.45} />
      <Hatch d="M 0 0 L 420 0 L 0 520 Z" x0={0} y0={0} x1={420} y1={520} gap={14} ang={35} w={4} op={0.6} />
      <Hatch d="M 1080 1100 L 1080 1920 L 560 1920 Z" x0={560} y0={1100} x1={1080} y1={1920} gap={14} ang={35} w={4} op={0.6} />
      <clipPath id="laugh-panel"><path d="M 0 0 L 1080 0 L 1080 1290 L 0 1310 Z" /></clipPath>
      <clipPath id="laugh-inset"><path d={pd} /></clipPath>
      <g clipPath="url(#laugh-panel)">
        <Bust look={JUDGE} act={(tt) => ({ x: 320, y: 800 - Math.abs(Math.sin(tt * 9)) * 18, s: 0.95, ex: { mouth: "shout", open: 0.7 + 0.3 * Math.abs(Math.sin(tt * 9)), eyes: "happy", glare: true, tilt: -6 + Math.sin(tt * 9) * 3 } })} />
        <Bust look={FAN} act={(tt) => ({ x: 790, y: 840 - Math.abs(Math.sin(tt * 9 + 1.3)) * 18, s: 0.85, ex: { mouth: "grin", open: 0.8 + 0.2 * Math.abs(Math.sin(tt * 8)), eyes: "happy", blush: 0.6, tilt: 7 + Math.sin(tt * 8) * 3 } })} />
      </g>
      <path d="M -20 1290 L 1100 1290 L 1100 1310 L -20 1310" fill="none" stroke={INK} strokeWidth={12} />
      <g transform={`rotate(-4 820 1160) translate(820 1160) scale(${k.toFixed(3)}) translate(-820 -1160)`}>
        <path d={pd} fill="#bfe6ff" />
        <g clipPath="url(#laugh-inset)">
          <SpeedLines cx={820} cy={1150} r0={110} r1={400} n={40} color="#fff" op={0.8} seed={3} />
          <Bust look={COOK} act={() => ({ x: 820, y: 1160, s: 0.52, ex: { mouth: "line", brow: 0.8, look: [-0.6, -0.4], sweat: true } })} />
        </g>
        <path d={pd} fill="none" stroke={INK} strokeWidth={10} strokeLinejoin="round" />
      </g>
      {t > T("B2%10") ? <Sfx x={320} y={400} text="HA HA HA!" size={104 * back(after("B2%10", 0.25))} rot={-12} fill="#ff8a6a" /> : null}
      {t > T("B2%40") ? <Sfx x={800} y={470} text="HAHA!" size={96 * back(after("B2%40", 0.25))} rot={10} fill="#ffc93c" /> : null}
      <Shake at="B2%10" dur={0.25} amp={12} />
      <Shake at="B2%40" dur={0.25} amp={12} />
    </Scene>
  );
};

// ---------------------------------------------------------------- win: the huge grin over the fire, then the impact frame and joy
const Win = () => {
  const { t, T } = useToon();
  const after = (at: string, d = 0.3) => clamp((t - T(at)) / d);
  const k = back(after("B4", 0.3));
  return (
    <Scene
      id="win"
      tr="flash"
      overlays={
        <Ov css="left:0;right:0;top:230px;text-align:center" enter={[{ preset: "stamp", at: "B4+.05" }]} during="B4..wine">
          <span className="pill" style={{ background: "#ffc93c", fontSize: 96, padding: "14px 40px" }}>1ST PRIZE</span>
        </Ov>
      }
    >
      <Show from="win" to="B4">
        <Backdrop id="win-burst" c0="#ffd36a" c1="#b8321a" cx={540} cy={900} />
        <SpeedLines cx={540} cy={900} r0={320} r1={1500} n={80} color="#fff" op={0.45} seed={7} spin={-10} />
        <Bust look={COOK} act={() => ({ x: 540, y: 900, s: 1.3, ex: { mouth: "grin", open: 1, eyes: "fierce", brow: 0.1, tilt: 2 } })} />
        <Wok x={800} y={1250} s={0.85} t={t} fire />
        {t > T("B3%45") ? <Sfx x={540} y={420} text="SIZZLE!" size={150 * back(after("B3%45", 0.25))} rot={-6} fill="#ffc93c" /> : null}
      </Show>
      <Show from="B4" to="wine">
        <Backdrop id="win-burst2" c0="#fff6c8" c1="#e0a018" cx={540} cy={820} />
        <SpeedLines cx={540} cy={820} r0={300} r1={1500} n={100} color="#fff" op={0.7} seed={11} spin={18} />
        <DotsPattern id="win-tone" color="#b06a00" size={18} r={3} />
        <rect width={1080} height={1920} fill="url(#win-tone)" opacity={0.2} />
        <ConfettiRain n={60} seed={5} />
        <Bust look={COOK} act={(tt) => ({ x: 540, y: 900, s: 1.2 + 0.1 * back(clamp((tt - T("B4")) / 0.3)), ex: { mouth: "cry", open: 0.9, eyes: "closed", tears: 1, fountain: true, brow: 0.9, tilt: -3 + Math.sin(tt * 2) * 1.5 } })} />
        <g transform={`translate(540 ${1385 - 30 * k}) scale(${(0.6 + 0.4 * k).toFixed(3)})`}>
          <path d="M -110 -120 L 110 -120 Q 104 20 0 40 Q -104 20 -110 -120 Z" fill="#ffc93c" stroke={INK} strokeWidth={8} strokeLinejoin="round" />
          <path d="M -110 -96 Q -180 -90 -150 -20 Q -130 10 -86 0 M 110 -96 Q 180 -90 150 -20 Q 130 10 86 0" fill="none" stroke={INK} strokeWidth={10} />
          <path d="M -20 40 L 20 40 L 30 90 L -30 90 Z M -70 90 L 70 90 L 70 120 L -70 120 Z" fill="#e0a018" stroke={INK} strokeWidth={7} strokeLinejoin="round" />
          <path d="M -70 -100 Q -60 -20 -20 10" fill="none" stroke="#fff6c8" strokeWidth={10} strokeLinecap="round" />
        </g>
        <g transform={`translate(700 1110) scale(${30 + 10 * Math.sin(t * 8)})`}>
          <Sparkle x={0} y={0} r={1} color="#fff" />
        </g>
        {t > T("B4%45") ? <Sfx x={800} y={500} text="WAAAH!" size={92 * back(after("B4%45", 0.25))} rot={10} fill="#8fd3ff" /> : null}
      </Show>
      <Impact at="B4" frames={3} />
      <FlashAt at="B4+.1" opacity={0.8} dur={0.3} />
      <Shake at="B4" dur={0.5} amp={28} />
      <Shake at="B3%45" dur={0.25} amp={10} />
    </Scene>
  );
};

export default function Film() {
  return (
    <AbsoluteFill>
      <ToonFilm>
        <Vow />
        <Laugh />
        <Win />
      </ToonFilm>
    </AbsoluteFill>
  );
}
