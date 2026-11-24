import { AbsoluteFill } from "remotion";
import { Ov, RadGrad, Scene, ToonFilm, clamp, eio, eout, trf, useToon } from "yt-toon/core";
import { Follow } from "yt-toon/comic";
import { Cook, Counter, Kitchen, Landscape, PastaNest, Pan, Plate, Pot, Steam, Tomato, mixColor } from "yt-toon/painted";

// Example episode in the painted storybook style: "Tomato pasta in 15 minutes, for 2 euros" (cartoon-shorts, painted style).
// Three scenes keyed to four beats (B0..B3): hook (meadow + teaser plate), kitchen (the cooking step), plate (the payoff).
export const meta = { durationInFrames: 438, fps: 30, width: 1080, height: 1920 };

const SMALL = { font: "800 26px Nunito", opacity: 0.8 };
const vis = (on: boolean) => (on ? undefined : { display: "none" as const });
const ClockIcon = () => (
  <svg viewBox="-30 -30 60 60" width={44} height={44}>
    <circle r={25} fill="#fffaf0" stroke="#4a3426" strokeWidth={5} />
    <path d="M0,-14 L0,0 L10,6" fill="none" stroke="#4a3426" strokeWidth={5} strokeLinecap="round" />
  </svg>
);
const CAM = (cx: number, cy: number, k: number, amount: number) => `translate(${cx},${cy}) scale(${(1 + amount * k).toFixed(4)}) translate(${-cx},${-cy})`;

// ================================================================ hook: dish, time and cost readable from frame 0
const Hook = () => {
  const { t, prog } = useToon();
  const k = prog(t, "hook", "hooke");
  return (
    <Scene
      id="hook"
      tr="cut"
      overlays={
        <>
          <Ov css="left:0;right:0;top:150px;text-align:center" cls="dish" enter={[{ preset: "nudge", at: "B0%10", dur: 0.4 }]}>Tomato<br />Pasta</Ov>
          <Ov css="left:80px;top:520px" enter={[{ preset: "nudge", at: "B0%45" }]}>
            <div className="stat"><ClockIcon /><b>15 min</b></div>
          </Ov>
          <Ov css="left:400px;top:520px" enter={[{ preset: "nudge", at: "B0%70" }]}>
            <div className="stat"><b><i>€</i>2</b><span style={SMALL}>serves 2</span></div>
          </Ov>
          <Ov css="left:720px;top:520px" enter={[{ preset: "nudge", at: "B0%85" }]}>
            <div className="stat"><b>Easy</b><span style={SMALL}>one pan</span></div>
          </Ov>
        </>
      }
    >
      <g transform={CAM(540, 900, k, 0.04)}>
        <Landscape seed={3} />
        <g transform={trf(540, 1190 + Math.sin(t * 1.4) * 4, 1.3 + 0.05 * k, 0)}>
          <Plate rx={250} ry={100} />
          <PastaNest w={300} h={118} seed={9} />
          <Steam x={0} y={-150} n={3} s={0.9} amt={1} />
        </g>
      </g>
    </Scene>
  );
};

// ================================================================ kitchen: garlic and oil, tomatoes crushed in, it bubbles
const SC = (m: number) => `B1%${m}`;
const Kitchen1 = () => {
  const { t, T, prog } = useToon();
  const at = (a: string, b: string) => clamp((t - T(a)) / (T(b) - T(a)));
  const k = prog(t, "kitchen", "kitchene");
  const sa = eio(at("B1%72", "B2%10"));
  const pp = eout(at("B2", "B2%25"));
  return (
    <Scene
      id="kitchen"
      tr="whip"
      overlays={
        <>
          <Ov css="left:60px;top:130px" enter={[{ preset: "left", at: "kitchen+.1" }]} during="kitchen..B2">
            <div className="step"><i>1</i><span>Garlic, oil, tomatoes</span></div>
          </Ov>
          <Ov css="left:60px;top:130px" enter={[{ preset: "left", at: "B2" }]} during="B2..kitchene">
            <div className="step"><i>2</i><span>Let it bubble</span></div>
          </Ov>
          <Ov css="left:560px;top:290px;width:420px;text-align:center" cls="tip" enter={[{ preset: "pop", at: "B2%35" }]}>while the<br />pasta cooks</Ov>
        </>
      }
    >
      <g transform={CAM(540, 1100, k, 0.05)}>
        <Kitchen />
        <Cook
          id="cook"
          x={270}
          y={800}
          s={0.9}
          act={(tt) => ({ ra: [34 + Math.sin(tt * 7) * 7 * (clamp((tt - T("B1%30")) / (T("kitchene") - T("B1%30"))) > 0 ? 1 : 0), -6], la: [18, -60], headR: 4 * Math.sin(tt * 1.7) + 6, talk: "voice", blink: "auto", bob: Math.sin(tt * 2.2) * 3, happy: tt > T("B2%60") })}
        />
        <Counter y={1240} />
        <g opacity={pp}>
          <g>
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <line key={i} x1={880 + (i - 4) * 9} y1={1060} x2={880 + (i - 4) * 26} y2={930 - Math.abs(i - 4) * 6} stroke={i % 3 ? "#f1c463" : "#d9a443"} strokeWidth={7} strokeLinecap="round" />
            ))}
          </g>
          <g transform="translate(880,1120) scale(.38)">
            <Pot>
              {[0, 1, 2, 3, 4].map((i) => {
                const ph = (t * 1.1 + i * 0.3) % 1;
                return <circle key={i} cx={-150 + i * 70} cy={-140} r={4 + ph * 14} fill="none" stroke="#e9f8ff" strokeWidth={5} opacity={(pp * (1 - ph)).toFixed(2)} />;
              })}
            </Pot>
          </g>
        </g>
        <Steam x={880} y={1040} n={2} s={0.55} amt={pp} />
        <g transform="translate(540,1250) scale(.55)">
          <Pan>
            <RadGrad id="kitchen-oil" stops={[[0, "#f6d77a", 0.8], [0.7, "#e2ae44", 0.55], [1, "#d9a63a", 0]]} />
            <RadGrad id="kitchen-sauce" stops={[[0, "#ee6038"], [0.55, "#cf3d24"], [0.85, "#a82a18"], [1, "#7a1c10"]]} cx={0.45} cy={0.42} r={0.62} />
            <ellipse cx={0} cy={10} rx={260} ry={108} fill="url(#kitchen-oil)" opacity={eio(at("B1%25", "B1%45")).toFixed(2)} />
            {[0, 1, 2, 3, 4, 5, 6].map((i) => {
              const a = eout(at(SC(6 + i * 3), SC(14 + i * 3)));
              return (
                <g key={i} transform={trf(-160 + i * 52, -30 + (i % 3) * 30 - 360 * (1 - a), 1, i * 40)} style={vis(a > 0)}>
                  <ellipse cx={0} cy={0} rx={22} ry={13} fill={mixColor("#fbeec8", "#f0c060", at("B1%40", "B1%70"))} stroke="#b0884a" strokeWidth={2.4} />
                  <ellipse cx={-6} cy={-4} rx={7} ry={3} fill="#fff" opacity={0.8} />
                </g>
              );
            })}
            <g opacity={sa.toFixed(2)}>
              <ellipse cx={0} cy={8} rx={304} ry={128} fill="url(#kitchen-sauce)" />
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => {
                const x = Math.sin(i * 2.3) * 210;
                const y = Math.cos(i * 1.7) * 70;
                return (
                  <g key={i}>
                    <ellipse cx={x.toFixed(1)} cy={y.toFixed(1)} rx={22} ry={13} fill={i % 3 ? "#e85a3a" : "#f27850"} stroke="#9a2414" strokeWidth={2} />
                    <ellipse cx={(x - 8).toFixed(1)} cy={(y - 5).toFixed(1)} rx={8} ry={3} fill="#fff" opacity={0.85} />
                  </g>
                );
              })}
              {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => {
                const ph = (t * 0.9 + i * 0.31) % 1;
                return <circle key={i} cx={(Math.sin(i * 3.7) * 200).toFixed(1)} cy={(Math.cos(i * 2.1) * 70).toFixed(1)} r={(3 + 16 * ph).toFixed(1)} fill="none" stroke="#ffa080" strokeWidth={5} opacity={(sa * (1 - ph)).toFixed(2)} />;
              })}
            </g>
          </Pan>
        </g>
        {[0, 1, 2].map((i) => {
          const a = at(SC(60 + i * 8), SC(72 + i * 8));
          return (
            <g key={i} transform={trf(470 + i * 70, 820 + 420 * eio(a), 1 - 0.4 * a, i * 50 + a * 90)} style={vis(a > 0 && a < 1)}>
              <Tomato r={44} />
            </g>
          );
        })}
        <Steam x={540} y={1160} n={3} s={1} amt={0.35 + 0.65 * sa} />
        <Follow of="cook" place={(_tt, h) => [h[0], h[1], 0.9, -18 + Math.sin(_tt * 7) * 7 * (clamp((_tt - T("B1%30")) / (T("kitchene") - T("B1%30"))) > 0 ? 1 : 0) * 1.5]}>
          <path d="M0,-60 L0,150" stroke="#8a5a33" strokeWidth={16} strokeLinecap="round" />
          <path d="M0,-60 L0,150" stroke="#c99560" strokeWidth={9} strokeLinecap="round" />
          <ellipse cx={0} cy={172} rx={22} ry={30} fill="#c99560" stroke="#8a5a33" strokeWidth={4} />
        </Follow>
      </g>
    </Scene>
  );
};

// ================================================================ plate: the payoff, the cook cheers
const PlateScene = () => {
  const { t, T, prog } = useToon();
  const k = prog(t, "plate", "platee");
  return (
    <Scene
      id="plate"
      tr="zoom"
      overlays={
        <Ov css="left:110px;right:110px;top:130px" enter={[{ preset: "down", at: "plate+.05" }]}>
          <div className="recap"><b>Tomato Pasta</b><div className="row"><span><ClockIcon /> 15 min</span><span><i>€</i>2</span><span>serves 2</span></div></div>
        </Ov>
      }
    >
      <g transform={CAM(540, 1150, k, 0.05)}>
        <Kitchen />
        <Cook
          x={540}
          y={760}
          s={0.85}
          act={(tt) => {
            const cheer = eout(clamp((tt - T("B3%55")) / (T("B3%80") - T("B3%55"))));
            return { la: [30 + 120 * cheer, 20 + 30 * cheer], ra: [30 + 120 * cheer, 20 + 30 * cheer], talk: "voice", happy: true, headR: 3 * Math.sin(tt * 2), bob: Math.sin(tt * 2.4) * 4 - 12 * cheer };
          }}
        />
        <Counter y={1240} />
        <g transform={trf(540, 1215, 1.5, 0)}>
          <Plate rx={250} ry={100} />
          <PastaNest w={300} h={118} seed={12} />
        </g>
        <Steam x={540} y={1040} n={3} s={0.85} amt={0.75} />
        {[0, 1, 2, 3, 4, 5, 6].map((i) => {
          const ph = (t * 0.7 + i / 7) % 1;
          return <path key={i} d="M0,-22 L5,-5 L22,0 L5,5 L0,22 L-5,5 L-22,0 L-5,-5Z" fill="#fff6c8" transform={`translate(${(540 + Math.cos(i * 2.4) * 330).toFixed(1)},${(1130 + Math.sin(i * 1.7) * 110).toFixed(1)}) scale(${Math.sin(Math.PI * ph).toFixed(3)}) rotate(${ph * 90})`} opacity={(Math.sin(Math.PI * ph) * 0.95).toFixed(2)} />;
        })}
      </g>
    </Scene>
  );
};

export default function Film() {
  return (
    <AbsoluteFill>
      <ToonFilm>
        <Hook />
        <Kitchen1 />
        <PlateScene />
      </ToonFilm>
    </AbsoluteFill>
  );
}
