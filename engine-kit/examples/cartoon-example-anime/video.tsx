import { AbsoluteFill } from "remotion";
import { Camera, DotsPattern, FlashAt, LinGrad, Ov, RadGrad, Scene, Shake, ToonFilm, clamp, eio, eout, useToon } from "yt-toon/core";
import { Bokeh, BlurFilter, Bust, Sparkle, SpeedLines, rng } from "yt-toon/anime";

// The Letter: an anime-style example (cartoon-shorts, anime style). A student opens the acceptance letter she waited a year for.
// Scenes: wait (worry, rain, the envelope), open (eye close-up, the letter slides out), joy (ACCEPTED, tears of joy).
// Every time is a beat mark (B0 = beat 0 starts, B3e = beat 3 ends), so a re-voice keeps the cuts in sync.
export const meta = { durationInFrames: 394, fps: 30, width: 1080, height: 1920 };

const INK = "#2b1a14";
const LOOK = {
  skin: "#fde3d0", skinS: "#eab49e", blushC: "#f2708a", hair: "#7a4a2a", hairS: "#4e2c16", hairH: "#c48a5c", hairStyle: "long",
  iris: "#3f63b0", irisL: "#a6d8ff", eyeW: 76, eyeH: 62, eyeGap: 54, lash: 1, jaw: 0, shirt: "#f4a9bb", shirtS: "#d9849c", trim: "#fff6ec",
};
const back = (x0: number) => {
  const x = clamp(x0);
  return 1 + 2.7 * Math.pow(x - 1, 3) + 1.7 * Math.pow(x - 1, 2);
};
const vis = (on: boolean) => (on ? undefined : { display: "none" as const });
const pp = (...a: (string | number)[]) => a.map((v) => (typeof v === "number" ? +v.toFixed(1) : v)).join(" ");

// props: the envelope (back, letter slot, front pocket) and the letter. Closed, the flap points down over the front; open, it folds up behind the letter.
const flapY = (h: number, open: number) => -h / 2 + h * 0.62 * (1 - 2 * open);
const Flap = ({ w, h, open }: { w: number; h: number; open: number }) => (
  <path d={pp("M", -w / 2, -h / 2, "L", 0, flapY(h, open), "L", w / 2, -h / 2, "Z")} fill={open > 0.5 ? "#e8d6b8" : "#f7ead4"} stroke={INK} strokeWidth={5} strokeLinejoin="round" />
);
const EnvBack = ({ x, y, w, h, rot = 0, open = 0 }: { x: number; y: number; w: number; h: number; rot?: number; open?: number }) => (
  <g transform={`translate(${x} ${y}) rotate(${rot})`}>
    {open > 0.5 ? <Flap w={w} h={h} open={open} /> : null}
    <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={10} fill="#f3e6d0" stroke={INK} strokeWidth={5} />
  </g>
);
const EnvFront = ({ x, y, w, h, rot = 0, open = 0 }: { x: number; y: number; w: number; h: number; rot?: number; open?: number }) => (
  <g transform={`translate(${x} ${y}) rotate(${rot})`}>
    <path d={pp("M", -w / 2, -h / 2 + 30, "L", 0, h * 0.12, "L", w / 2, -h / 2 + 30, "L", w / 2, h / 2, "L", -w / 2, h / 2, "Z")} fill="#fbf1df" stroke={INK} strokeWidth={5} strokeLinejoin="round" />
    <path d={pp("M", -w / 2, h / 2, "L", -w * 0.08, h * 0.02, "M", w / 2, h / 2, "L", w * 0.08, h * 0.02)} fill="none" stroke="#d8c3a2" strokeWidth={4} />
    {open <= 0.5 ? (
      <>
        <Flap w={w} h={h} open={open} />
        <circle cx={0} cy={flapY(h, open) - 6} r={30} fill="#d6455d" stroke={INK} strokeWidth={4} />
        <Sparkle x={0} y={flapY(h, open) - 6} r={16} color="#ffd0d8" />
      </>
    ) : null}
  </g>
);
const Hands = ({ x, y, w, dy = 0 }: { x: number; y: number; w: number; dy?: number }) => (
  <>
    {[-1, 1].map((sd) => {
      const hx = x + sd * (w / 2 - 6);
      const hy = y + dy;
      return (
        <g key={sd}>
          <ellipse cx={hx} cy={hy} rx={44} ry={58} fill={LOOK.skin} stroke={INK} strokeWidth={4.5} />
          <path d={pp("M", hx - sd * 30, hy - 20, "Q", hx - sd * 46, hy, hx - sd * 30, hy + 22)} fill="none" stroke={LOOK.skinS} strokeWidth={5} strokeLinecap="round" />
        </g>
      );
    })}
  </>
);
const Letter = ({ x, y, w, h, rot = 0, word = "" }: { x: number; y: number; w: number; h: number; rot?: number; word?: string }) => {
  const top = -h / 2 + 120;
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={8} fill="#ffffff" stroke={INK} strokeWidth={5} />
      <circle cx={0} cy={-h / 2 + 56} r={30} fill="none" stroke="#7d6ab0" strokeWidth={5} />
      <Sparkle x={0} y={-h / 2 + 56} r={18} color="#7d6ab0" />
      {word ? (
        <text x={0} y={top + 34} textAnchor="middle" fontFamily="Anton" fontSize={Math.min(64, w * 0.18)} fill="#d6455d" letterSpacing={3}>{word}</text>
      ) : null}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect key={i} x={-w / 2 + 50} y={top + (word ? 70 : 10) + i * 34} width={(w - 100) * (i % 3 === 2 ? 0.6 : 1)} height={12} rx={6} fill="#d9d2e6" />
      ))}
    </g>
  );
};

// ---------------------------------------------------------------- wait: a year of waiting, shaking hands
const WIN = "M 150 470 L 930 470 L 930 1240 L 150 1240 Z";
const R1 = rng(21);
const BOKEH = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25].map((i) => ({ x: 170 + R1() * 740, y: 820 + R1() * 380, r: 18 + R1() * 34, c: ["#ffd166", "#ff9fb2", "#8ec5ff", "#c7b6ff"][i % 4]! }));
const Wait = () => {
  const { t, T } = useToon();
  const shaking = t >= T("B1");
  const j = shaking ? Math.sin(t * 70) * 5 : 0;
  const Rr = rng(5);
  const v = 1 + 364 * eio(clamp((t - T("B0")) / (T("B0e") - T("B0") - 0.2)));
  return (
    <Scene
      id="wait"
      tr="cut"
      overlays={
        <Ov css="left:60px;right:60px;top:200px;text-align:center" enter={[{ preset: "down", at: 0.1 }]}>
          <div className="kicker">DAY</div>
          <div className="title" style={{ fontSize: 170 }}>{Math.round(v)}</div>
        </Ov>
      }
    >
      <Camera a="wait" b="waite" from={1} to={1.05} cx={540} cy={1000} />
      <LinGrad id="wait-bg" stops={[[0, "#17143a"], [0.6, "#2e2a63"], [1, "#4b3f7e"]]} />
      <LinGrad id="wait-win" stops={[[0, "#0e1030"], [1, "#2a2c5e"]]} />
      <clipPath id="wait-clip"><path d={WIN} /></clipPath>
      <BlurFilter id="wait-blur" sd={3} />
      <rect width={1080} height={1920} fill="url(#wait-bg)" />
      <path d={WIN} fill="url(#wait-win)" />
      <g clipPath="url(#wait-clip)">
        <g filter="url(#wait-blur)">
          {BOKEH.map((b, i) => (
            <Bokeh key={i} x={b.x} y={b.y} r={b.r} color={b.c} op={0.55} />
          ))}
        </g>
        <g>
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69].map((i) => {
            const x = 150 + Rr() * 780;
            const y = 470 + ((Rr() * 800 + t * (1100 + Rr() * 400)) % 800);
            return <line key={i} x1={x} y1={y} x2={x - 8} y2={y + 46} stroke="#b9c8ff" strokeWidth={2.5} opacity={0.45} />;
          })}
        </g>
      </g>
      <path d={WIN + " M 540 470 L 540 1240 M 150 860 L 930 860"} fill="none" stroke="#14112e" strokeWidth={18} />
      <Bust
        look={LOOK}
        act={(tt) => {
          const sh = tt >= T("B1");
          const blink = Math.abs(tt - T("B0%70")) < 0.06 || Math.abs(tt - T("B1%60")) < 0.06;
          return { x: 540, y: 870 + Math.sin(tt * 2.2) * 4, s: 1.45, ex: { eyes: blink ? "closed" : "open", look: [0, 0.7], lid: 0.2, brow: sh ? 0.85 : 0.55, mouth: sh ? "frown" : "line", sweat: sh, wet: sh ? 0.5 : 0 } };
        }}
      />
      <EnvBack x={540 + j} y={1175} w={420} h={220} rot={-3 + j * 0.3} />
      <EnvFront x={540 + j} y={1175} w={420} h={220} rot={-3 + j * 0.3} open={0} />
      <Hands x={540 + j} y={1200} w={440} dy={Math.cos(t * 63) * (shaking ? 3 : 0)} />
      {shaking
        ? [-1, 1].map((sd) => (
            <path key={sd} d={pp("M", 540 + sd * 290, 1120, "q", sd * 18, 20, 0, 40, "q", -sd * 18, 20, 0, 40)} fill="none" stroke="#fff6ec" strokeWidth={6} strokeLinecap="round" opacity={0.8} />
          ))
        : null}
    </Scene>
  );
};

// ---------------------------------------------------------------- open: her eyes, the letter slides out
const PANEL = "M 70 250 L 1010 250 L 1010 700 L 70 700 Z";
const Open = () => {
  const { t, T } = useToon();
  const prog = (a: string, d: number) => clamp((t - T(a)) / d);
  const k = eout(prog("B2%15", T("B2%70") - T("B2%15")));
  const open = clamp(k * 3);
  return (
    <Scene id="open" tr="whip">
      <Camera a="open" b="opene" from={1} to={1.06} cx={540} cy={900} />
      <RadGrad id="open-bg" stops={[[0, "#5a4c9c"], [1, "#14112e"]]} cx={0.5} cy={0.55} r={0.7} />
      <DotsPattern id="open-tone" color="#0b0920" size={16} r={2.4} />
      <clipPath id="open-clip"><path d={PANEL} /></clipPath>
      <rect width={1080} height={1920} fill="url(#open-bg)" />
      <SpeedLines cx={540} cy={1040} r0={320} r1={1500} n={110} color="#ffffff" op={0.35} seed={7} spin={8} />
      <rect width={1080} height={1920} fill="url(#open-tone)" opacity={0.35} />
      <g clipPath="url(#open-clip)">
        <path d={PANEL} fill={LOOK.skin} />
        <Bust
          look={LOOK}
          act={(tt) => {
            const kk = clamp((tt - T("B2%50")) / 0.6);
            return { x: 540, y: 520, s: 3, ex: { eyes: tt > T("B2%55") ? "wide" : "open", look: [0, 0.6 - 0.6 * kk], lid: 0.15 * (1 - kk), brow: 0.4 - 0.3 * kk, wet: kk, mouth: "line" } };
          }}
        />
        {[[250, 330, 34], [830, 340, 40], [880, 620, 22]].map(([x, y, r]) => (
          <g key={`${x}`} transform={`translate(${x} ${y}) scale(${(r! * back(prog("B2%55", 0.3))).toFixed(3)})`} style={vis(t > T("B2%55"))}>
            <Sparkle x={0} y={0} r={1} color="#ffffff" />
          </g>
        ))}
      </g>
      <path d={PANEL} fill="none" stroke="#fff6ec" strokeWidth={10} />
      <path d={PANEL} fill="none" stroke={INK} strokeWidth={4} />
      <EnvBack x={540} y={1130} w={520} h={280} rot={2} open={open} />
      <Letter x={540} y={1130 - 210 * k} w={440} h={360} rot={2 - 3 * k} />
      <EnvFront x={540} y={1130} w={520} h={280} rot={2} open={open} />
      <Hands x={540} y={1170} w={540} dy={0} />
      <text x={0} y={0} textAnchor="middle" fontFamily="Bangers" fontSize={120} fill="#ffd166" stroke={INK} strokeWidth={12} paintOrder="stroke" strokeLinejoin="round" transform={`translate(850 860) rotate(12) scale(${back(prog("B2%10", 0.3)).toFixed(3)})`} style={vis(t > T("B2%10"))}>RIP!</text>
    </Scene>
  );
};

// ---------------------------------------------------------------- joy: ACCEPTED, tears of joy
const R2 = rng(9);
const DRIFT = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((i) => ({ r: 24 + R2() * 46, c: ["#ffffff", "#ffe08a", "#ffc2d1", "#d8c8ff"][i % 4]!, x: 80 + R2() * 920, y0: R2() * 1500, sp: 40 + R2() * 60 }));
const STARS = [[150, 520, 40], [930, 600, 52], [200, 1000, 30], [900, 1040, 36], [110, 780, 22], [960, 820, 26]];
const Joy = () => {
  const { t, T } = useToon();
  const prog = (a: string, d: number) => clamp((t - T(a)) / d);
  const lift = 1 - eout(prog("joy", 0.5));
  const cry = t >= T("B3e");
  const bob = cry ? Math.abs(Math.sin(t * 5)) * -12 : 0;
  return (
    <Scene
      id="joy"
      tr="flash"
      overlays={
        <>
          <Ov css="left:60px;right:60px;top:210px;text-align:center;color:#ffd166;font-size:160px" cls="title" enter={[{ preset: "stamp", at: "B3" }]}>ACCEPTED!</Ov>
          <Ov css="left:60px;right:60px;top:392px;text-align:center;color:#fff6ec;font-size:56px" cls="kicker" enter={[{ preset: "up", at: "B4" }]}>AFTER 365 DAYS</Ov>
        </>
      }
    >
      <Camera a="joy" b="joye" from={1} to={1.07} cx={540} cy={950} />
      <RadGrad id="joy-bg" stops={[[0, "#fff1c9"], [0.45, "#ffb3c1"], [1, "#9c4d86"]]} cx={0.5} cy={0.45} r={0.75} />
      <rect width={1080} height={1920} fill="url(#joy-bg)" />
      <SpeedLines cx={540} cy={900} r0={380} r1={1600} n={90} color="#ffffff" op={0.5} seed={3} spin={-6} />
      {DRIFT.map((d, i) => (
        <g key={i} transform={`translate(${(d.x + Math.sin(t + i) * 20).toFixed(1)} ${(1400 - ((d.y0 + t * d.sp) % 1300)).toFixed(1)})`}>
          <Bokeh x={0} y={0} r={d.r} color={d.c} op={0.5} />
        </g>
      ))}
      {STARS.map(([x, y, r], i) => (
        <g key={i} transform={`translate(${x} ${y}) rotate(${(t * 40 + i * 30).toFixed(1)}) scale(${(r! * back(prog("B3", 0.35)) * (0.6 + 0.4 * Math.abs(Math.sin(t * 3 + i)))).toFixed(2)})`}>
          <Sparkle x={0} y={0} r={1} color="#ffffff" />
        </g>
      ))}
      <Bust
        look={LOOK}
        act={(tt) => {
          const cr = tt >= T("B3e");
          const kk = clamp((tt - T("B3e")) / 1.4);
          const b = cr ? Math.abs(Math.sin(tt * 5)) * -12 : 0;
          const tilt = Math.sin(tt * 2.4) * 3;
          const ex = tt >= T("B4%55")
            ? { eyes: "open" as const, mouth: "grin" as const, open: 0.6, wet: 1, tears: 1, blush: 1, brow: 0.45, tilt }
            : cr
              ? { eyes: "closed" as const, mouth: "grin" as const, open: 0.8, tears: 0.35 + 0.65 * kk, blush: 1, brow: 0.6, tilt }
              : { eyes: "wide" as const, mouth: "open" as const, open: 0.7, wet: 1, tears: 0.15, blush: 0.5, brow: 0.25, look: [0, -0.2] as [number, number] };
          return { x: 540, y: 960 + b, s: 1.5, ex };
        }}
      />
      <Letter x={830} y={1010 + bob + 160 * lift} w={260} h={330} rot={10 - 6 * Math.sin(t * 2.4)} word="ACCEPTED" />
      <ellipse cx={812} cy={1170 + bob + 160 * lift} rx={46} ry={56} fill={LOOK.skin} stroke={INK} strokeWidth={4.5} />
      <FlashAt at="B3" opacity={0.9} dur={0.3} />
      <Shake at="B3" dur={0.35} amp={18} />
    </Scene>
  );
};

export default function Film() {
  return (
    <AbsoluteFill>
      <ToonFilm>
        <Wait />
        <Open />
        <Joy />
      </ToonFilm>
    </AbsoluteFill>
  );
}
