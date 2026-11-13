import React from 'react';
import { AbsoluteFill } from 'remotion';
import { useCurrentFrame } from 'remotion';
import { BigTitle, Captions, Kicker, ProgressBar, ShortsBackdrop, EASE_INOUT, prog } from '../../lib/shorts';
import { Boiler, Bulb, Cable, Dam, Donut, EL, ElectricDefs, MagnetCoil, Pylon, SolarPanel, Turbine, WindTurbine } from '../../lib/electric';
import { FONT_DISPLAY } from '../../fonts';
import { VO } from './vo.gen';

// =============================================================================
// COMPOSITION CONFIG
// =============================================================================
export const compositionConfig = {
  id: 'Short19Electricity',
  durationInSeconds: 47.2,
  fps: 30,
  width: 1080,
  height: 1920,
};

// =============================================================================
// TIMELINE — beats from the new app (hook / faraday=setup / 4 reveal steps / twist / payoff=loop).
// No QUIZ pause: the narration has no gap for one. All cues are GLOBAL spoken-word times (s).
// =============================================================================
const TOT = 1416;
const S = (sec: number) => Math.round(sec * 30);
const ramp = (f: number, a: number, b: number) => EASE_INOUT(prog(f, S(a), S(b)));
const win = (f: number, a0: number, a1: number, b0: number, b1: number) => ramp(f, a0, a1) * (1 - ramp(f, b0, b1));
const mix = (a: number, b: number, p: number) => a + (b - a) * p;

// Rotor angles: integrated speed (deg/frame) keyframed to the narration, then a gentle spin-down that
// lands on a symmetric pose so the LAST frame equals frame 0.
const makeRot = (keys: [number, number][], sym: number, k = 1) => {
  const arr: number[] = [0];
  for (let f = 1; f < TOT; f++) {
    const t = f / 30;
    let v = keys[keys.length - 1][1];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        v = mix(keys[i - 1][1], keys[i][1], (t - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]));
        break;
      }
    }
    arr.push(arr[f - 1] + v * k);
  }
  const end = arr[TOT - 1];
  const target = Math.ceil(end / sym) * sym;
  return arr.map((a, f) => a + (target - end) * EASE_INOUT(prog(f, 1330, TOT - 1)));
};
const SPEED: [number, number][] = [[0, 0], [1, 2], [3.3, 4], [6.5, 14], [7.9, 10], [14, 5], [19.5, 6], [24.3, 7], [25.5, 18], [31, 18], [32.6, 12], [36, 5], [42, 3], [46.7, 2]];
const ROT = makeRot(SPEED, 45);
const WIND_ROT = makeRot(SPEED, 120, 0.6);
const WHEEL_ROT = makeRot(SPEED, 45, 0.9);
const speedAt = (f: number) => (ROT[Math.min(TOT - 1, f + 1)] - ROT[f]);

// Turbine poses (cx, cy, r)
const POSE_A: [number, number, number] = [540, 1120, 170]; // grid / payoff
const POSE_BIG: [number, number, number] = [540, 900, 330]; // zoom into the machine
const POSE_B: [number, number, number] = [400, 1110, 260]; // working generator

const CHIP_FONT: React.CSSProperties = { fontFamily: FONT_DISPLAY, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 };

const Chip: React.FC<{ text: string; color: string; at: number; size?: number }> = ({ text, color, at, size = 40 }) => {
  const f = useCurrentFrame();
  const p = EASE_INOUT(prog(f, S(at), S(at) + 8));
  return (
    <div style={{ ...CHIP_FONT, fontSize: size, color, border: `3px solid ${color}`, borderRadius: 999, padding: '8px 26px', background: 'rgba(8,12,28,0.72)', opacity: p, transform: `translateY(${(1 - p) * 14}px) scale(${0.94 + 0.06 * p})` }}>
      {text}
    </div>
  );
};
const ChipRow: React.FC<{ y: number; from: number; to: number; children: React.ReactNode }> = ({ y, from, to, children }) => {
  const f = useCurrentFrame();
  const o = ramp(f, from, from + 0.2) * (1 - ramp(f, to - 0.3, to));
  if (o < 0.01) return null;
  return <div style={{ position: 'absolute', top: y, left: 40, right: 40, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 14, opacity: o }}>{children}</div>;
};
const Arrow: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame();
  return <div style={{ ...CHIP_FONT, fontSize: 48, color: '#fff', opacity: prog(f, S(at), S(at) + 6) }}>{'➜'}</div>;
};

// Living backdrop: drifting brand glows (whole-number sine cycles over TOT so frame 0 == last).
const LivingBackdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const a = (2 * Math.PI * frame) / TOT;
  const blob = (cx: number, cy: number, r: number, color: string, k: number, ph: number, amp: number) => (
    <div style={{ position: 'absolute', left: cx + Math.sin(a * k + ph) * amp - r, top: cy + Math.cos(a * k + ph) * amp - r, width: r * 2, height: r * 2, borderRadius: '50%', background: `radial-gradient(circle, ${color} 0%, transparent 68%)` }} />
  );
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {blob(200, 380, 520, 'rgba(99,102,241,0.26)', 2, 0, 90)}
      {blob(900, 900, 560, 'rgba(155,124,196,0.18)', 3, 2, 80)}
      {blob(300, 1500, 520, 'rgba(77,184,168,0.20)', 2, 4, 100)}
      <AbsoluteFill style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.07) 1.5px, transparent 1.6px)', backgroundSize: '54px 54px', opacity: 0.6 }} />
    </AbsoluteFill>
  );
};

// =============================================================================
// THE WORLD — one persistent SVG canvas, everything evolves on it.
// =============================================================================
const World: React.FC = () => {
  const f = useCurrentFrame();
  const PH = (3 * f) / (TOT - 1); // periodic pulse phase (exact loop)
  const tt = f; // free-running phase for flames / waves

  // --- camera: hook settle -> payoff pull-back from the bulb -> loop grow (ends == frame 0) ---
  const settle = 1.06 - 0.06 * EASE_INOUT(prog(f, 0, 28));
  const pp = f < S(42.11) ? 1 : EASE_INOUT(prog(f, S(42.11), S(45.6)));
  const grow = 1 + 0.06 * EASE_INOUT(prog(f, 1376, TOT - 1));
  const zs = 1 + 1.15 * (1 - pp);
  const camTx = mix(540, 540, 1) + 0;
  const camTy = 700 + (1 - pp) * 80;

  // --- layer opacities ---
  const gridOp = f < S(3.3) ? 1 : f < S(7) ? 1 - ramp(f, 3.3, 6.5) : ramp(f, 42.11, 43.2);
  const mcOp = win(f, 7.3, 7.9, 13.9, 14.5);
  const bigPose = f < S(7.9) ? ramp(f, 3.3, 7.3) : 0;
  const turbOp = f < S(3.3) ? 1 : f < S(7.3) ? 1 : f < S(13.9) ? 1 - ramp(f, 7.3, 7.9) : f < S(42.1) ? ramp(f, 13.9, 14.5) * (1 - ramp(f, 32.6, 33.5)) : ramp(f, 42.11, 43.0);
  const showB = f >= S(7.9) && f < S(42.1);
  const turbPose: [number, number, number] = showB ? POSE_B : f < S(3.3) || f >= S(42.1) ? POSE_A : [mix(POSE_A[0], POSE_BIG[0], bigPose), mix(POSE_A[1], POSE_BIG[1], bigPose), mix(POSE_A[2], POSE_BIG[2], bigPose)];
  const spd = speedAt(Math.min(f, TOT - 2));
  const blurAmt = Math.max(0, Math.min(1, (spd - 6) / 14));
  const coilGlow = f < S(14) ? 0.5 : mix(0.35, 1, ramp(f, 18.87, 19.6));

  const boilOp = win(f, 19.7, 20.4, 26.0, 26.8);
  const windOp = win(f, 26.0, 26.7, 32.2, 33.0);
  const solarOp = win(f, 32.0, 32.9, 36.6, 37.3);
  const donutOp = win(f, 36.74, 37.4, 41.5, 42.2);
  const outBulbOp = win(f, 13.9, 14.6, 36.4, 37.0);

  // output bulb: beside the generator, then centre-stage under the solar panel
  const bs = ramp(f, 32.0, 33.0);
  const outGlow = f < S(18.8) ? 0.3 : mix(0.3, 1, ramp(f, 18.87, 19.6));
  const outBulb = { x: mix(905, 540, bs), y: mix(1090, 1215, bs), s: mix(0.8, 1.05, bs), g: Math.max(outGlow, ramp(f, 35.9, 36.4)) };

  // --- Faraday magnets + coil ---
  const ang = f < S(9.4) ? 0 : (f - S(9.4)) * 4.5;
  const flowOn = ramp(f, 12.38, 12.9);
  const needleAmp = ramp(f, 13.2, 13.6) * 0.95;
  const gridPulse = [[230, 1330, 230, 1348], [830, 1330, 830, 1348]];

  // hook: light-flood bursts from the bulb
  const bursts = [S(1.57), S(1.57) + 7, S(1.57) + 14].map((a, i) => {
    const p = prog(f, a, a + 34);
    if (p <= 0 || p >= 1) return null;
    return <circle key={i} cx={540} cy={720} r={150 + p * 560} fill="none" stroke={i === 1 ? '#fff' : EL.gold} strokeWidth={8 - p * 6} opacity={(1 - p) * 0.7} />;
  });

  // solar
  const solarLit = ramp(f, 33.85, 35.6);
  const solarBeams = ramp(f, 35.0, 35.5);

  // donut counts up on "twenty-one percent"
  const dp = ramp(f, 38.3, 39.7);
  const pctLabel = `${Math.round(21 * dp)}%`;

  return (
    <svg width={1080} height={1920} viewBox="0 0 1080 1920" style={{ position: 'absolute', inset: 0 }}>
      <ElectricDefs />
      <g transform={`translate(540 960) scale(${settle}) translate(-540 -960)`}>
        <g transform={`translate(540 960) scale(${grow}) translate(-540 -960)`}>
          <g transform={`translate(540 ${camTy}) scale(${zs}) translate(-540 -700)`}>
            {/* ================= GRID VIEW: frame 0 / payoff ================= */}
            {gridOp > 0.01 ? (
              <g opacity={gridOp}>
                <path d="M 0 1352 Q 270 1296 540 1340 T 1080 1322 V 1920 H 0 Z" fill="#0f1830" />
                <path d="M 0 1352 Q 270 1296 540 1340 T 1080 1322" fill="none" stroke="#2a3a6a" strokeWidth={4} />
                <Pylon x={330} baseY={1332} h={250} />
                <Pylon x={750} baseY={1332} h={250} />
                <path d="M 330 1112 Q 540 1160 750 1112 M 0 1060 Q 165 1120 330 1112 M 750 1112 Q 915 1060 1080 1040" stroke="#8fa0bd" strokeWidth={4} fill="none" />
                <Bulb cx={540} cy={720} s={1.25} glow={1} />
                {bursts}
                <Cable pts={[[540, 925], [540, 960]]} phase={PH * 2} width={10} n={2} />
                <WindTurbine x={250} baseY={1332} h={380} rot={WIND_ROT[f]} />
                <SolarPanel cx={850} cy={1110} w={440} lit={1} beams={0.5} flow={PH * 3} t={tt} />
                <Cable pts={[[250, 1332], [250, 1350], [540, 1350], [540, 1290]]} phase={PH * 2} color={EL.cyan} width={8} n={4} pulse={7} />
                <Cable pts={[[850, 1308], [850, 1350], [540, 1350]]} phase={PH * 2} color={EL.cyan} width={8} n={3} pulse={7} />
              </g>
            ) : null}

            {/* ================= SETUP: Faraday magnets + coil ================= */}
            {mcOp > 0.01 ? (
              <g opacity={mcOp}>
                <MagnetCoil cx={540} cy={820} ang={ang} flow={f * 0.012} flowOn={flowOn} needle={needleAmp * Math.sin((ang * Math.PI) / 180)} fieldOn={ramp(f, 11.1, 11.8)} />
              </g>
            ) : null}

            {/* ================= REVEAL 2: boiler -> steam pipe ================= */}
            {boilOp > 0.01 ? (
              <g opacity={boilOp} transform={`translate(0 ${(1 - boilOp) * -40})`}>
                <Boiler cx={440} cy={570} w={640} t={tt} fire={0.4 + 0.6 * ramp(f, 19.96, 20.9)} />
                <Cable pts={[[760, 560], [840, 560], [840, 868], [400, 868], [400, 890]]} phase={f * 0.012} color="#eef3fb" width={16} n={8} pulse={11} opacity={ramp(f, 23.9, 24.6)} />
              </g>
            ) : null}

            {/* ================= REVEAL 3: wind + hydro spin it directly ================= */}
            {windOp > 0.01 ? (
              <g opacity={windOp}>
                <g transform="translate(600 840) scale(1.15)"><Dam x={0} y={0} t={tt} rot={WHEEL_ROT[f]} /></g>
                <WindTurbine x={250} baseY={850} h={300} rot={WIND_ROT[f] * 1.8} />
                <Cable pts={[[250, 850], [250, 880], [400, 880]]} phase={f * 0.012} color={EL.cyan} width={10} n={4} opacity={ramp(f, 28.7, 29.6)} />
                <Cable pts={[[554, 880], [554, 892], [400, 892]]} phase={f * 0.012} color={EL.blue} width={10} n={4} opacity={ramp(f, 29.4, 30.2)} />
              </g>
            ) : null}

            {/* ================= REVEAL 4: solar panel, no spinning ================= */}
            {solarOp > 0.01 ? (
              <g opacity={solarOp} transform={`translate(0 ${(1 - solarOp) * 40})`}>
                <SolarPanel cx={540} cy={690} w={780} lit={solarLit} beams={solarBeams} flow={f * 0.014} t={tt} />
                <Cable pts={[[540, 920], [540, 1000], [540, 1110]]} phase={f * 0.012} color={EL.gold} width={10} n={4} opacity={ramp(f, 35.9, 36.3)} />
              </g>
            ) : null}

            {/* ================= TWIST: 21% renewables ================= */}
            {donutOp > 0.01 ? (
              <g opacity={donutOp}>
                <Donut cx={540} cy={760} r={290} pct={0.21 * dp} label={pctLabel} />
                <g opacity={ramp(f, 37.67, 38.4)}>
                  <WindTurbine x={190} baseY={1390} h={270} rot={WIND_ROT[f]} />
                  <SolarPanel cx={540} cy={1260} w={320} lit={1} beams={0} flow={f * 0.014} t={tt} />
                  <g transform="translate(770 1390) scale(0.8)"><Dam x={0} y={0} t={tt} rot={WHEEL_ROT[f]} /></g>
                </g>
              </g>
            ) : null}

            {/* ================= persistent machine + output bulb ================= */}
            {f >= S(13.9) && f < S(33.5) ? (
              <Cable pts={[[POSE_B[0] + POSE_B[2] * 1.2, POSE_B[1]], [outBulb.x, POSE_B[1]]]} phase={f * 0.014} width={10} n={5} opacity={outBulbOp * ramp(f, 18.87, 19.4)} />
            ) : null}
            {turbOp > 0.01 ? (
              <g opacity={turbOp}>
                <Turbine cx={turbPose[0]} cy={turbPose[1]} r={turbPose[2]} rot={ROT[f]} glow={coilGlow} blur={blurAmt} />
              </g>
            ) : null}
            {outBulbOp > 0.01 ? (
              <g opacity={outBulbOp}>
                <Bulb cx={outBulb.x} cy={outBulb.y} s={outBulb.s} glow={outBulb.g} />
              </g>
            ) : null}
          </g>
        </g>
      </g>
    </svg>
  );
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================
const Short19Electricity: React.FC = () => {
  const f = useCurrentFrame();
  const titleOp = f < S(3.3) ? 1 : f < S(40) ? 1 - ramp(f, 3.3, 4.4) : ramp(f, 44.4, 45.4);
  return (
    <AbsoluteFill style={{ background: '#0b1020' }}>
      <ShortsBackdrop base="#0b1020" glow="#1a2650" />
      <LivingBackdrop />
      <World />

      {/* HOOK / LOOP headline — identical at frame 0 and the last frame */}
      <div style={{ opacity: titleOp }}>
        <BigTitle warm lines={[{ text: 'HOW ELECTRICITY' }, { text: 'IS REALLY MADE', color: EL.gold }]} subtitle="a 200-year-old trick" y={170} size={90} />
      </div>

      <Kicker text="A TRICK FROM THE 1820s" color={EL.gold} y={185} at={S(5.3)} until={S(7.7)} />
      <Kicker text="THE DISCOVERY" color={EL.cyan} y={185} at={S(7.8)} until={S(13.9)} />
      <Kicker text="THE GENERATOR" color={EL.indigo} y={185} at={S(14.2)} until={S(19.9)} />
      <Kicker text="HEAT MAKES STEAM" color="#ff9a52" y={185} at={S(20)} until={S(26)} />
      <Kicker text="SKIP THE HEAT" color={EL.cyan} y={185} at={S(26.1)} until={S(31.9)} />
      <Kicker text="NO SPINNING AT ALL" color={EL.gold} y={185} at={S(32)} until={S(36.7)} />
      <Kicker text="THE U.S. MIX" color={EL.cyan} y={185} at={S(36.8)} until={S(42)} />

      <ChipRow y={300} from={6.3} to={7.7}>
        <Chip text="200 YEARS OLD" color={EL.gold} at={6.44} size={50} />
      </ChipRow>
      <ChipRow y={290} from={8.8} to={13.9}>
        <Chip text="FARADAY" color={EL.cyan} at={8.9} />
        <Chip text="1820s" color={EL.gold} at={7.98} />
      </ChipRow>
      <ChipRow y={290} from={17.6} to={19.9}>
        <Chip text="MECHANICAL" color={EL.gold} at={17.73} />
        <Arrow at={18.63} />
        <Chip text="ELECTRICAL" color={EL.cyan} at={18.87} />
      </ChipRow>
      <ChipRow y={285} from={19.9} to={26}>
        <Chip text="COAL" color="#ff9a52" at={19.96} size={34} />
        <Chip text="GAS" color={EL.gold} at={20.5} size={34} />
        <Chip text="NUCLEAR" color={EL.cyan} at={20.96} size={34} />
        <Chip text="SOLAR-THERMAL" color={EL.red} at={22.57} size={34} />
      </ChipRow>
      <ChipRow y={290} from={26} to={32}>
        <Chip text="WIND" color={EL.cyan} at={26.01} />
        <Chip text="HYDRO" color={EL.blue} at={26.47} />
        <Chip text="NO HEAT" color={EL.red} at={27.17} />
      </ChipRow>
      <ChipRow y={290} from={33.6} to={36.6}>
        <Chip text="SEMICONDUCTORS" color={EL.cyan} at={33.85} size={38} />
      </ChipRow>

      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 520, background: 'linear-gradient(to bottom, rgba(6,9,22,0), rgba(6,9,22,0.88))' }} />
      <Captions lines={VO} y={1500} accent={EL.gold} />
      <ProgressBar color={EL.gold} />
    </AbsoluteFill>
  );
};

export default Short19Electricity;
