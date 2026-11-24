import { AbsoluteFill } from "remotion";
import { Camera, LinGrad, Ov, Scene, Shake, Show, ToonFilm, clamp, eio, eout, lerp, trf, useToon } from "yt-toon/core";
import { CamRig, Rays, Skyline, Stars, Streetlight } from "yt-toon/fx";
import { Follow, P, Puppet, cycle, mix, pose } from "yt-toon/comic";

// Where does your ₹20 go? A UPI payment as a comic short (cartoon-shorts, comic style). Every time is a beat mark (B0..B13) or a scene id.
export const meta = { durationInFrames: 1244, fps: 30, width: 1080, height: 1920 };

const OL = "#17111b";
const blink = (t: number) => (((t + 0.4) % 3.3) < 0.09 ? 1 : 0);

// the cast: original characters
const CUST = { skin: "#b07a52", skinD: "#8a5a38", hair: "#1c1412", hairStyle: "short", top: "suit", shirt: "#33415c", shirtD: "#222c40", tie: "#e8343d", trim: "#fbf3e4", num: null, legs: "pants", pants: "#2a3146", shoe: "#3b2a20", shoeD: "#24180f", sock: null };
const SELLER = { skin: "#9c6644", skinD: "#7a4c30", hair: "#2a1a12", hairStyle: "short", beard: true, cap: "#d8574a", capD: "#a83a30", top: "tee", shirt: "#f0a33a", shirtD: "#c9822a", trim: "#fbf3e4", num: null, legs: "pants", pants: "#5a4030", shoe: "#2a1d16", shoeD: "#1a120e", sock: null };
const CLERK_S = { skin: "#c58c62", skinD: "#9c6844", hair: "#3a2416", hairStyle: "puff", top: "shirt", shirt: "#3aa37a", shirtD: "#2a7d5c", glasses: "#17111b", trim: "#fbf3e4", num: null, legs: "pants", pants: "#2a3146", sock: null };
const CLERK_Y = { skin: "#d6a27a", skinD: "#b07e58", hair: "#1c1412", hairStyle: "short", top: "suit", shirt: "#2f5fa8", shirtD: "#22457a", tie: "#ffd23f", trim: "#fbf3e4", num: null, legs: "pants", pants: "#22293d", sock: null };
const OPER = { skin: "#8a5a3c", skinD: "#6a3f28", hair: "#1c1412", hairStyle: "bald", top: "polo", shirt: "#7a4fd0", shirtD: "#5a36a0", trim: "#ffd23f", num: null, legs: "pants", pants: "#22293d", sock: null };
const NEXT = { ...CUST, top: "tee", shirt: "#3aa37a", shirtD: "#2a7d5c", hairStyle: "puff", tie: null };

// ---------------- props ----------------
type TxtProps = { s: string; x: number; y: number; size: number; fill?: string; font?: string; outline?: number };
const Txt = ({ s, x, y, size, fill = "#fff", font = "Anton", outline }: TxtProps) => (
  <text x={x} y={y} fontFamily={font} fontSize={size} fill={fill} textAnchor="middle" stroke={outline ? OL : undefined} strokeWidth={outline} paintOrder={outline ? "stroke" : undefined}>{s}</text>
);
const Phone = ({ screen }: { screen: string }) => (
  <g>
    <rect x={-22} y={-40} width={44} height={80} rx={9} fill="#1c2030" stroke={OL} strokeWidth={5} />
    <rect x={-16} y={-32} width={32} height={60} rx={4} fill={screen} />
  </g>
);
const Envelope = ({ col = "#ff7a3d", mark = "", style }: { col?: string; mark?: string; style?: React.CSSProperties }) => (
  <g style={style}>
    <rect x={-60} y={-40} width={120} height={80} rx={8} fill={col} stroke={OL} strokeWidth={7} />
    <path d="M-56 -36 L0 8 L56 -36" fill="none" stroke="#fbf3e4" strokeWidth={7} strokeLinejoin="round" />
    <circle cx={0} cy={6} r={13} fill="#d0342c" stroke={OL} strokeWidth={4} />
    {mark ? <Txt s={mark} x={0} y={-52} size={60} font="Bangers" outline={6} /> : null}
  </g>
);
const Coin = ({ r = 70, style }: { r?: number; style?: React.CSSProperties }) => (
  <g style={style}>
    <circle r={r} fill="#f2b53a" stroke={OL} strokeWidth={8} />
    <circle r={r * 0.72} fill="none" stroke="#c98a1c" strokeWidth={6} />
    <Txt s="₹" x={0} y={r * 0.36} size={r * 1.05} fill="#8a5a10" />
  </g>
);
const Cup = ({ style }: { style?: React.CSSProperties }) => (
  <g style={style}>
    <path d="M-24 -50 L24 -50 L18 0 L-18 0 Z" fill="#f3c98b" stroke={OL} strokeWidth={6} />
    <rect x={-24} y={-50} width={48} height={12} fill="#c98a5a" />
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
const CELLS = [0, 1, 2, 3, 4, 5];
const qr = (a: number, b: number) => (a * 7 + b * 3) % 5 < 2 || (a < 2 && b < 2) || (a > 3 && b < 2) || (a < 2 && b > 3);
const StallFront = ({ lit }: { lit: boolean }) => (
  <g>
    <rect x={520} y={1020} width={520} height={270} rx={10} fill="#2f8f6a" stroke={OL} strokeWidth={8} />
    <rect x={505} y={995} width={550} height={36} rx={8} fill="#c98a5a" stroke={OL} strokeWidth={7} />
    <Txt s="CHAI" x={780} y={1200} size={130} fill="#fbf3e4" font="Bangers" outline={10} />
    <rect x={560} y={880} width={110} height={118} rx={8} fill="#fff" stroke={OL} strokeWidth={6} />
    {CELLS.map((a) => CELLS.map((b) => (qr(a, b) ? <rect key={`${a}-${b}`} x={570 + a * 15} y={892 + b * 15} width={15} height={15} fill={OL} /> : null)))}
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
const Pill = ({ size, at, during, children }: { size: number; at: string; during: string; children: string }) => (
  <Ov css="left:0;right:120px;top:300px;text-align:center" enter={[{ preset: "pop", at }]} during={during}>
    <div className="pill" style={{ fontSize: size }}>{children}</div>
  </Ov>
);

// ---------------------------------------------------------------- hook: the chai payment
const Hook = () => {
  const { t, T } = useToon();
  const tap = T("B0%45");
  const paid = T("B0%75");
  const turn = T("B1");
  return (
    <Scene
      id="hook"
      tr="cut"
      words={[{ word: "PAID!", x: 360, y: 600, rot: -6, at: "B0%75", until: "B1", fill: "#7fd18b", size: 120 }, { word: "?", x: 560, y: 470, rot: 4, at: "B1%30", until: "hooke", size: 150 }]}
      overlays={
        <Ov css="left:0;right:120px;top:210px;text-align:center" enter={[{ preset: "slam", at: 0.1 }]}>
          <div className="title" style={{ fontSize: 230, color: "var(--gold)" }}>₹20</div>
          <div className="kicker" style={{ fontSize: 50 }}>one chai</div>
        </Ov>
      }
    >
      <Camera a="hook" b="hooke" from={1} to={1.05} cx={540} cy={1000} />
      <Street sid="hook" />
      <Puppet options={SELLER} act={(tt) => ({ pose: pose(P.stand, { turn: 0.45, face: tt > paid ? "grin" : "smile", blink: blink(tt) }), x: 860, y: 1290, dir: -1, s: 1 })} />
      <StallBack />
      <StallFront lit={false} />
      <Puppet
        id="cust"
        options={CUST}
        act={(tt) => {
          const up = eout(clamp((tt - 0.05) / 0.45));
          const p = pose(mix(P.stand, pose(P.point, { hand: "fist" }), up), { face: tt > paid ? "grin" : "focus", blink: blink(tt + 1) });
          return { pose: tt >= turn ? mix(p, pose(P.hold, { turn: 0.8, face: "worry", hd: 10 }), eout(clamp((tt - turn) / 0.35))) : p, x: 330, y: 1290, dir: 1, s: 1 };
        }}
      />
      <Follow of="cust" dx={10} dy={-30} s={1.15} place={(tt, h) => [h[0] + 10, h[1] - 30, 1.15, tt >= turn ? -8 : 0]}>
        <Phone screen={t > paid ? "#7fd18b" : t > tap && t < tap + 0.15 ? "#ffffff" : "#9ad7ff"} />
      </Follow>
    </Scene>
  );
};

// ---------------------------------------------------------------- phone: does a coin fly?
const PhoneScene = () => {
  const { t, T } = useToon();
  const a = T("B2%10");
  const back = T("B3");
  const out = T("B3%40");
  const up = eout(clamp((t - a) / 0.7));
  const dn = eio(clamp((t - back) / 0.35));
  const k = eio(clamp((t - out) / 0.9));
  return (
    <Scene
      id="phone"
      tr="zoom"
      words={[{ word: "?", x: 760, y: 330, rot: 6, at: "B2%40", until: "B3", size: 150 }, { word: "NOPE!", x: 540, y: 330, rot: -5, at: "B3", until: "B3%40", fill: "#ff6a5a", size: 150 }]}
      above={
        <Show from="B3" to="phonee">
          <path d="M380 800 L700 1120 M700 800 L380 1120" stroke="#e8343d" strokeWidth={46} strokeLinecap="round" />
        </Show>
      }
    >
      <LinGrad id="phone-bg" stops={[[0, "#1d2550"], [1, "#3a2a6a"]]} />
      <rect x={0} y={0} width={1080} height={1920} fill="url(#phone-bg)" />
      <Show from="B2" to="B3">
        <Rays cx={540} cy={700} n={18} color="#ffd23f" op={0.18} speed={8} />
      </Show>
      <rect x={250} y={470} width={580} height={980} rx={70} fill="#1c2030" stroke={OL} strokeWidth={14} />
      <rect x={290} y={560} width={500} height={800} rx={30} fill={t >= back ? "#bfe6c4" : "#9ad7ff"} />
      <Txt s="UPI" x={540} y={680} size={110} fill="#17111b" />
      <Txt s="PAY ₹20 → CHAI STALL" x={540} y={1300} size={40} fill="#17111b" />
      <path d="M170 1500 q-40 -300 80 -420 l40 0 l0 380 z" fill="#b07a52" stroke={OL} strokeWidth={10} />
      <g transform={trf(540, lerp(1000, 330, up * (1 - dn)), 1, (t - a) * 240)} style={t >= a && t < back + 0.35 ? undefined : { display: "none" }}>
        <Coin r={90} />
      </g>
      <g transform={trf(lerp(540, 980, k), lerp(980, 160, k), lerp(0.4, 1.3, k), -14 * k)} style={t >= out ? undefined : { display: "none" }}>
        <Envelope />
      </g>
      <Shake at="B3" dur={0.3} amp={18} />
    </Scene>
  );
};

// ---------------------------------------------------------------- switch: one hub wired to every bank
const SwitchScene = () => {
  const { t, T } = useToon();
  const go = T("B4%20");
  const catchT = T("B4%80");
  const hub = [540, 760];
  return (
    <Scene
      id="switch"
      tr="whip"
      overlays={
        <Ov css="left:0;right:120px;top:1000px;text-align:center" enter={[{ preset: "pop", at: "B5%30" }]} during="B5%30..switche">
          <div className="pill" style={{ fontSize: 44 }}>every bank → one hub</div>
        </Ov>
      }
    >
      <Camera a="switch" b="switche" from={1.02} to={1.08} cx={540} cy={900} />
      <LinGrad id="switch-bg" stops={[[0, "#0e1a33"], [1, "#1d2f55"]]} />
      <rect x={0} y={0} width={1080} height={1920} fill="url(#switch-bg)" />
      <rect x={120} y={190} width={840} height={120} rx={18} fill="#16243f" stroke={OL} strokeWidth={8} />
      <Txt s="UPI SWITCH" x={540} y={285} size={96} fill="#71e0d0" />
      {Array.from({ length: 12 }, (_, k) => {
        const x = 150 + (k % 6) * 156;
        const y = k < 6 ? 420 : 560;
        const on = t >= T("B5") + (k * (T("B5e") - T("B5") - 0.2)) / 12;
        return (
          <g key={k}>
            <line x1={x} y1={y} x2={hub[0]} y2={hub[1]} stroke={on ? "#ffb81c" : "#3a4a70"} strokeWidth={8} />
            <rect x={x - 44} y={y - 40} width={88} height={80} rx={12} fill="#2a3a60" stroke={OL} strokeWidth={6} />
            <circle cx={x} cy={y} r={18} fill={on ? "#ffd23f" : "#4a5878"} stroke={OL} strokeWidth={4} />
          </g>
        );
      })}
      <circle cx={hub[0]} cy={hub[1]} r={50} fill="#ff7a3d" stroke={OL} strokeWidth={8} />
      <Puppet id="op" options={OPER} act={(tt) => ({ pose: pose(mix(P.stand, P.hold, eout(clamp((tt - catchT + 0.3) / 0.3))), { turn: 0.85, face: tt > catchT ? "grin" : "wow", blink: blink(tt) }), x: 540, y: 1290, dir: 1, s: 1 })} />
      <g>
        <rect x={280} y={1060} width={520} height={230} rx={16} fill="#3a4f6e" stroke={OL} strokeWidth={8} />
        <Txt s="NPCI" x={540} y={1210} size={110} fill="#fbf3e4" />
      </g>
      <Follow
        of="op"
        place={(tt, h) => {
          const k = eio(clamp((tt - go) / (catchT - go)));
          return tt < catchT ? [lerp(-80, h[0], k), lerp(120, h[1] - 40, k) - 260 * Math.sin(Math.PI * k), 0.9, 360 * (1 - k)] : [h[0], h[1] - 40, 0.9, 0];
        }}
      >
        <Envelope style={t >= go ? undefined : { display: "none" }} />
      </Follow>
    </Scene>
  );
};

// ---------------------------------------------------------------- banks: shop's bank, your bank, shop's bank
const Bank = ({ cx, name, col }: { cx: number; name: string; col: string }) => (
  <g>
    <path d={`M${cx - 430} 520 L${cx} 300 L${cx + 430} 520 Z`} fill="#efe6d4" stroke={OL} strokeWidth={9} />
    <rect x={cx - 430} y={520} width={860} height={80} fill="#e2d6bf" stroke={OL} strokeWidth={9} />
    <Txt s={name} x={cx} y={585} size={62} fill={col} />
    <rect x={cx - 380} y={600} width={760} height={460} fill="#f6efe0" stroke={OL} strokeWidth={9} />
    {[-330, -190, 190, 330].map((dx) => (
      <rect key={dx} x={cx + dx - 26} y={600} width={52} height={460} fill="#fbf7ee" stroke={OL} strokeWidth={6} />
    ))}
    <rect x={cx - 140} y={700} width={280} height={360} fill="#3a2f40" stroke={OL} strokeWidth={7} />
  </g>
);
const BankCounter = ({ cx }: { cx: number }) => <rect x={cx - 260} y={1050} width={520} height={240} rx={12} fill="#8a5a3a" stroke={OL} strokeWidth={8} />;
const BanksScene = () => {
  const { t, T } = useToon();
  const ask = T("B6%30");
  const show = T("B6%70");
  const open = T("B7%45");
  const k = eio(clamp((t - T("banks")) / (ask - T("banks"))));
  const o = eout(clamp((t - open) / 0.3));
  const up = eout(clamp((t - show + 0.3) / 0.3));
  return (
    <Scene
      id="banks"
      tr="zoom"
      words={[{ word: "−₹20", x: 600, y: 470, rot: -6, at: "B7%70", until: "B8-0.3", fill: "#ff6a5a", size: 150 }, { word: "+₹20", x: 790, y: 400, rot: 6, at: "B8%40", until: "bankse", fill: "#7fd18b", size: 140 }]}
    >
      <LinGrad id="banks-sky" stops={[[0, "#7fb6e8"], [1, "#d8ecff"]]} />
      <LinGrad id="banks-ground" stops={[[0, "#cbbba0"], [1, "#8a7a64"]]} />
      <rect x={0} y={0} width={1080} height={1920} fill="url(#banks-sky)" />
      <CamRig keys={[["banks", 300, 900, 1], ["B7-0.35", 300, 900, 1], ["B7+0.25", 1400, 900, 1, 0, "io"], ["B8-0.3", 1400, 900, 1], ["B8+0.15", 300, 900, 1, 0, "io"]]}>
        <rect x={-600} y={1060} width={3000} height={900} fill="url(#banks-ground)" />
        <Bank cx={300} name="SHOP'S BANK" col="#2a7d5c" />
        <Puppet id="clerkS" options={CLERK_S} act={(tt) => ({ pose: pose(mix(P.stand, pose(P.reach, { nua: 150, nfa: 10 }), eout(clamp((tt - show + 0.3) / 0.3))), { turn: 0.8, face: tt > show ? "grin" : tt > ask ? "wow" : "neutral", blink: blink(tt) }), x: 300, y: 1290, dir: 1, s: 1 })} />
        <Bank cx={1400} name="YOUR BANK" col="#22457a" />
        <Puppet options={CLERK_Y} act={(tt) => ({ pose: pose(tt > T("B7%65") ? P.point : P.stand, { turn: 0.8, face: tt > open ? "smile" : "focus", blink: blink(tt + 1) }), x: 1400, y: 1290, dir: 1, s: 1 })} />
        <g transform={trf(lerp(-200, 300, k), lerp(200, 880, k), 0.9, 0)} style={t < show ? undefined : { display: "none" }}>
          <Envelope col="#ff7a3d" mark="?" />
        </g>
        <g transform={trf(1660, 820, 1, 0)}>
          <rect x={-55} y={-40} width={110} height={90} rx={12} fill="#ffd23f" stroke={OL} strokeWidth={7} />
          <path d="M-32 -40 v-30 a32 32 0 0 1 64 0 v30" fill="none" stroke={OL} strokeWidth={12} transform={`translate(32 ${-10 * o}) rotate(${-40 * o}) translate(-32 0)`} />
          <Txt s="PIN" x={0} y={28} size={44} fill="#17111b" />
        </g>
        <BankCounter cx={300} />
        <BankCounter cx={1400} />
        <Follow of="clerkS" place={(_tt, h) => [h[0] - 20, h[1] + 20, 1, -4]}>
          <g style={up > 0 ? undefined : { display: "none" }}>
            <rect x={-10} y={-150} width={270} height={140} rx={14} fill="#fff3df" stroke={OL} strokeWidth={7} />
            <Txt s="CHAI" x={125} y={-88} size={58} fill="#17111b" />
            <Txt s="STALL" x={125} y={-30} size={58} fill="#e8343d" />
          </g>
        </Follow>
      </CamRig>
    </Scene>
  );
};

// ---------------------------------------------------------------- back at the stall: two yeses, DING
const BackScene = () => {
  const { t, T } = useToon();
  const ding = T("B10");
  const give = T("B10%55");
  const lit = t >= ding && t < ding + 1.6 && (t - ding) % 0.4 < 0.3;
  return (
    <Scene
      id="back"
      tr="whip"
      words={[{ word: "DING!", x: 740, y: 640, rot: -6, at: "B10", until: "B10%60", fill: "#ffd23f", size: 150 }]}
      overlays={
        <>
          <Pill size={52} at="B10%10" during="B10%10..backe">PAYMENT RECEIVED ₹20</Pill>
        </>
      }
    >
      <Camera a="back" b="backe" from={1.04} to={1} cx={540} cy={1000} />
      <Street sid="back" />
      <Puppet
        id="seller"
        options={SELLER}
        act={(tt) => {
          const cheer = tt >= ding && tt < give;
          const sp = cheer ? pose(P.celebrate, { lift: 40 * Math.abs(Math.sin((tt - ding) * 7)) }) : mix(P.stand, P.reach, eout(clamp((tt - give + 0.3) / 0.3)));
          return { pose: pose(sp, { turn: 0.5, face: tt >= ding ? "grin" : "neutral", blink: blink(tt) }), x: 860, y: 1290, dir: -1, s: 1 };
        }}
      />
      <StallBack />
      <StallFront lit={lit} />
      <Puppet
        id="cust"
        options={CUST}
        act={(tt) => {
          const cp = tt >= give ? mix(P.stand, P.hold, eout(clamp((tt - give) / 0.3))) : P.stand;
          return { pose: pose(cp, { turn: 0.5, face: tt >= ding ? "grin" : "wow", blink: blink(tt + 1) }), x: 330, y: 1290, dir: 1, s: 1 };
        }}
      />
      <Follow of="seller" place={(_tt, h) => [h[0], h[1] - 4, 1, 0]}>
        <Cup style={t > give - 0.3 && t < give ? undefined : { display: "none" }} />
      </Follow>
      <Follow of="cust" place={(_tt, h) => [h[0], h[1] - 4, 1, 0]}>
        <Cup style={t >= give ? undefined : { display: "none" }} />
      </Follow>
      {[T("B9"), T("B9%45")].map((a, i) => {
        const k = eio(clamp((t - a) / 0.8));
        return (
          <g key={i} transform={trf(lerp(200 + 200 * i, 740, k), lerp(-100, 930, k), lerp(1, 0.4, k), 0)} style={t >= a && k < 1 ? undefined : { display: "none" }}>
            <Envelope col="#7fd18b" mark="YES" />
          </g>
        );
      })}
    </Scene>
  );
};

// ---------------------------------------------------------------- twist: no coin moved; settled later
const TwistScene = () => {
  const { t, T } = useToon();
  const a = T("B12%15");
  const k = eio(clamp((t - a) / 2.0));
  return (
    <Scene
      id="twist"
      tr="flash"
      words={[{ word: "STILL HERE!", x: 540, y: 420, rot: -4, at: "B11%35", until: "B12", fill: "#7fd18b", size: 120 }]}
      overlays={
        <>
          <Pill size={52} at="B12%30" during="B12%30..twiste">settled later, in batches</Pill>
        </>
      }
    >
      <Camera a="twist" b="twiste" from={1} to={1.06} cx={540} cy={900} />
      <LinGrad id="twist-bg" stops={[[0, "#2a2440"], [1, "#15121f"]]} />
      <rect x={0} y={0} width={1080} height={1920} fill="url(#twist-bg)" />
      {[[290, "YOURS"], [790, "SHOP'S"]].map(([cx, name]) => (
        <g key={name}>
          <rect x={(cx as number) - 200} y={560} width={400} height={560} rx={20} fill="#3a3456" stroke={OL} strokeWidth={9} />
          <Txt s={name as string} x={cx as number} y={650} size={70} fill="#fbf3e4" />
          {Array.from({ length: 8 }, (_, s) => [-70, 70].map((dx) => <ellipse key={`${s}${dx}`} cx={(cx as number) + dx} cy={1060 - s * 44} rx={64} ry={22} fill="#f2b53a" stroke={OL} strokeWidth={6} />))}
          <rect x={(cx as number) - 180} y={700} width={360} height={400} fill="#bfe3ff" opacity={0.18} />
        </g>
      ))}
      <Show from="B12" to="twiste">
        <rect x={0} y={0} width={1080} height={1920} fill="#070a1c" opacity={0.5} />
        <Stars n={40} w={1080} h={500} seed={5} op={0.8} />
        <circle cx={860} cy={220} r={60} fill="#f3ecd0" />
        <circle cx={830} cy={200} r={60} fill="#0b0e22" />
      </Show>
      <g transform={trf(lerp(-300, 1400, k), 1280, 1, 0)} style={t >= a ? undefined : { display: "none" }}>
        <rect x={-230} y={-190} width={330} height={190} rx={16} fill="#e9dfcc" stroke={OL} strokeWidth={8} />
        <path d="M100 -150 L190 -150 L230 -80 L230 0 L100 0 Z" fill="#2f8f6a" stroke={OL} strokeWidth={8} />
        {[-150, 150].map((x) => (
          <circle key={x} cx={x} cy={0} r={38} fill="#17111b" stroke="#555" strokeWidth={8} />
        ))}
        <Txt s="BATCH" x={-65} y={-75} size={70} fill="#17111b" />
      </g>
    </Scene>
  );
};

// ---------------------------------------------------------------- big: the next customer, and 820 million more
const BigScene = () => {
  const { t, T } = useToon();
  const arrive = T("B13%25");
  const give = T("B13%60");
  const ding = T("B13%30");
  const v = lerp(1, 820, eio(clamp((t - T("B13%45")) / 1.4)));
  const label = v < 2 ? "1" : v >= 819.5 ? "820M" : Math.round(v) + "M";
  return (
    <Scene
      id="big"
      tr="whip"
      words={[{ word: "DING!", x: 740, y: 640, rot: -6, at: "B13%30", until: "B13%60", fill: "#ffd23f", size: 130 }]}
      overlays={
        <>
          <Ov css="left:0;right:120px;top:200px;text-align:center" enter={[{ preset: "down", at: "B13%42" }]}>
            <div className="title" style={{ fontSize: 150, color: "var(--gold)" }}>{label}</div>
            <div className="kicker" style={{ fontSize: 46 }}>UPI payments a day</div>
          </Ov>
        </>
      }
    >
      <Camera a="big" b="bige" from={1.1} to={1} cx={540} cy={1000} />
      <Street sid="big" />
      {[0, 1, 2, 3].map((i) => {
        const d0 = T("B13%45") + i * 0.3;
        return (
          <g key={i} transform={trf(-330 + i * 330, 438, 0.42, 0)}>
            <StallBack />
            <StallFront lit={t >= d0 && (t - d0) % 1.3 < 0.35} />
          </g>
        );
      })}
      <Puppet
        id="seller"
        options={SELLER}
        act={(tt) => {
          const reach = tt > give - 0.4 && tt < give + 0.2;
          const closing = tt > T("bige") - 1.6;
          return { pose: pose(reach ? P.reach : closing ? pose(P.stand, { turn: 0.95 }) : P.stand, { turn: closing ? 0.95 : 0.5, face: "grin", blink: blink(tt + 0.7) }), x: 860, y: 1290, dir: -1, s: 1 };
        }}
      />
      <StallBack />
      <StallFront lit={t >= ding && t < ding + 0.6} />
      <Puppet
        id="cust"
        options={NEXT}
        act={(tt) => {
          const w = clamp((tt - T("big")) / (arrive - T("big")));
          const x = lerp(-150, 330, eio(w));
          const walking = w > 0 && w < 1;
          const p0 = walking ? pose(cycle((tt - T("big")) * 9, 1, "walk"), { face: "smile" }) : mix(P.stand, pose(P.point, { hand: "fist" }), eout(clamp((tt - arrive) / 0.3)));
          const p = tt > give ? mix(p0, P.hold, eout(clamp((tt - give) / 0.3))) : p0;
          return { pose: pose(p, { turn: walking ? 0.2 : 0.6, face: tt >= ding ? "grin" : "smile", blink: blink(tt) }), x, y: 1290, dir: 1, s: 1 };
        }}
      />
      <Follow of="cust" place={(_tt, h) => [h[0] + 10, h[1] - 30, 1.15, 0]}>
        <g style={t < give ? undefined : { display: "none" }}>
          <Phone screen={t >= ding ? "#7fd18b" : "#9ad7ff"} />
        </g>
      </Follow>
      <Follow of="seller" place={(_tt, h) => [h[0], h[1] - 4, 1, 0]}>
        <Cup style={t > give - 0.4 && t < give ? undefined : { display: "none" }} />
      </Follow>
      <Follow of="cust" place={(_tt, h) => [h[0], h[1] - 4, 1, 0]}>
        <Cup style={t >= give ? undefined : { display: "none" }} />
      </Follow>
    </Scene>
  );
};

export default function Film() {
  return (
    <AbsoluteFill>
      <ToonFilm bg="#1b1630">
        <Hook />
        <PhoneScene />
        <SwitchScene />
        <BanksScene />
        <BackScene />
        <TwistScene />
        <BigScene />
      </ToonFilm>
    </AbsoluteFill>
  );
}
