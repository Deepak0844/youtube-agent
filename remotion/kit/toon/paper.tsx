import React, { useId } from "react";
import paperFactory from "./upstream/paper.js";
import { Puppet, type PoseName, type Pose, type PuppetFrame } from "./comic";
import { useSceneId } from "./scene-parts";
import { useToon } from "./Stage";

// yt-toon/paper: the "paper and light" look of cartoon-shorts (styles/paper.js). A diorama of cut paper (torn edges, soft shadows between
// layers) lit like a film (glows, light rays, dust), characters as backlit silhouettes, words cut out of card. Everything here is plain SVG
// drawn from time, so a layer that moves is just a layer whose props change with t. Colours are CSS strings; positions are stage units.

/* eslint-disable @typescript-eslint/no-explicit-any */
const lib: any = (() => {
  const w: Record<string, unknown> = {};
  paperFactory(w, {} as Document); // the shape maths are pure; nothing is drawn until a component asks
  return w.Paper;
})();
const f = (n: number) => +(+n).toFixed(1);
const hid = (prefix: string, key: string) => {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return `${prefix}${(h >>> 0).toString(36)}`;
};

/** A hand-cut closed outline through the polygon [[x, y], ...] (a path `d`); the same points and seed give the same edge every frame. */
export const torn = (pts: number[][], amp = 4, seed = 1, step = 18): string => lib.torn(pts, amp, seed, step);
/** Points for a hill, skyline or wave line from x0 to x1, closed down to yb: the top at x is hFn(x). */
export const ridge = (x0: number, x1: number, yb: number, hFn: (x: number) => number, step = 30): number[][] => lib.ridge(x0, x1, yb, hFn, step);
/** Parallax transform for a camera layer: depth 1 moves most, bigger depths move less; push 0..1 over the shot. */
export const parallax = (depth: number, push: number, cx = 540, cy = 860, amount = 0.12, pan: [number, number] = [0, 0]): string => {
  const s = 1 + (amount * push) / depth;
  const dx = (pan[0] * push) / depth;
  const dy = (pan[1] * push) / depth;
  return `translate(${f(cx + dx)} ${f(cy + dy)}) scale(${s.toFixed(4)}) translate(${-cx} ${-cy})`;
};
/** cartoon-shorts' seeded random numbers: const R = rng(12); R() gives the same 0..1 sequence every time. */
export const rng = (seed: number): (() => number) => lib.rng(seed);
/** 14609 -> "14,609". */
export const thousands = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export type GradStops = [number, string, number?][];
const Stops: React.FC<{ stops: GradStops }> = ({ stops }) => (
  <>
    {stops.map(([o, c, op = 1], i) => (
      <stop key={i} offset={o} stopColor={c} stopOpacity={op} />
    ))}
  </>
);
// a gradient id unique to this use (a gradient defined inside a hidden scene does not paint in the scene that is showing)
const useGid = () => "g" + useId().replace(/[^a-zA-Z0-9]/g, "");

/** A rectangle filled with a vertical gradient (top to bottom): stops [[offset, colour, opacity?], ...]. */
export const GradRect: React.FC<{ x?: number; y?: number; width: number; height: number; stops: GradStops }> = ({ x = 0, y = 0, width, height, stops }) => {
  const id = useGid();
  return (
    <>
      <linearGradient id={id} x1={0} y1={0} x2={0} y2={1}>
        <Stops stops={stops} />
      </linearGradient>
      <rect x={x} y={y} width={width} height={height} fill={`url(#${id})`} />
    </>
  );
};

/** One paper layer: flat colour (or a vertical gradient `grad`), a lighter cut edge on top, a shadow beneath. `pts` is torn; a string is a path used as is. */
export const Layer: React.FC<{ pts: number[][] | string; fill?: string; amp?: number; seed?: number; step?: number; grad?: GradStops; small?: boolean; shadow?: boolean; edge?: string | false; ew?: number }> = ({ pts, fill, amp, seed, step, grad, small, shadow, edge, ew }) => {
  const d = typeof pts === "string" ? pts : torn(pts, amp ?? 3.5, seed ?? 1, step ?? 16);
  const sid = useSceneId();
  const gid = useGid();
  return (
    <g filter={shadow === false ? "none" : `url(#${small ? "paper-cuts-" : "paper-cut-"}${sid})`}>
      {grad ? (
        <linearGradient id={gid} x1={0} y1={0} x2={0} y2={1}>
          <Stops stops={grad} />
        </linearGradient>
      ) : null}
      <path d={d} fill={grad ? `url(#${gid})` : fill} />
      {edge !== false ? <path d={d} fill="none" stroke={edge || "rgba(255,248,230,.28)"} strokeWidth={ew || 2.5} /> : null}
    </g>
  );
};

/** A soft radial glow (screen blend). */
export const Glow: React.FC<{ x: number; y: number; r: number; color: string; op?: number }> = ({ x, y, r, color, op = 0.8 }) => {
  const stops: GradStops = [[0, color, 1], [0.35, color, 0.45], [1, color, 0]];
  const id = useGid();
  return (
    <>
      <radialGradient id={id}>
        <Stops stops={stops} />
      </radialGradient>
      <circle cx={f(x)} cy={f(y)} r={f(r)} fill={`url(#${id})`} opacity={op} style={{ mixBlendMode: "screen" }} />
    </>
  );
};

/** A fan of `n` light rays from (x, y) toward `ang` degrees (0 right, 90 down, 180 left), flickering with time. */
export const Rays: React.FC<{ x: number; y: number; ang: number; spread: number; len: number; n: number; color: string; op?: number; seed?: number }> = ({ x, y, ang, spread, len, n, color, op = 0.35, seed = 3 }) => {
  const { t } = useToon();
  const R = lib.rng(seed) as () => number;
  const stops: GradStops = [[0, color, 1], [1, color, 0]];
  const id = useGid();
  return (
    <g style={{ mixBlendMode: "screen" }}>
      <radialGradient id={id} cx={x} cy={y} r={len} fx={x} fy={y} gradientUnits="userSpaceOnUse">
        <Stops stops={stops} />
      </radialGradient>
      {Array.from({ length: n }, (_, i) => {
        const a = ((ang + (i / (n - 1 || 1) - 0.5) * spread + (R() - 0.5) * 4) * Math.PI) / 180;
        const w = ((1.5 + R() * 3) * Math.PI) / 180;
        const fl = 0.6 + 0.4 * Math.sin(t * (1 + R() * 2) + i * 1.7);
        return <path key={i} d={`M ${x} ${y} L ${f(x + Math.cos(a - w) * len)} ${f(y + Math.sin(a - w) * len)} L ${f(x + Math.cos(a + w) * len)} ${f(y + Math.sin(a + w) * len)} Z`} fill={`url(#${id})`} opacity={f(op * fl * 100) / 100} />;
      })}
    </g>
  );
};

/** Dust or embers drifting in the box [x0, y0, w, h]. `up` px/s (18), `drift` (6), `size` (3), `op` (.7). */
export const Dust: React.FC<{ n: number; box: [number, number, number, number]; color?: string; seed?: number; up?: number; drift?: number; size?: number; op?: number }> = ({ n, box, color = "#fff6d6", seed = 5, up = 18, drift = 6, size = 3, op = 0.7 }) => {
  const { t } = useToon();
  const R = lib.rng(seed) as () => number;
  const [x0, y0, w, h] = box;
  return (
    <g style={{ mixBlendMode: "screen" }}>
      {Array.from({ length: n }, (_, i) => {
        const px = x0 + ((((R() * w + Math.sin(t * 0.6 + i) * 30 + t * drift) % w) + w) % w);
        const py = y0 + ((((R() * h - t * up * (0.5 + R())) % h) + h) % h);
        const r = size * (0.4 + R());
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * (1 + R() * 2) + i));
        return <circle key={i} cx={f(px)} cy={f(py)} r={f(r)} fill={color} opacity={f(tw * op * 100) / 100} />;
      })}
    </g>
  );
};

/** Paper confetti falling over the full 1080 width, each piece with a small shadow. */
export const PaperConfetti: React.FC<{ n: number; seed?: number; colors?: string[]; speed?: number }> = ({ n, seed = 7, colors = ["#1f4fa8", "#f4b73b", "#f7eedb", "#1f4fa8", "#ffd97a"], speed = 1 }) => {
  const { t } = useToon();
  const sid = useSceneId();
  const R = lib.rng(seed) as () => number;
  return (
    <g filter={`url(#paper-cuts-${sid})`}>
      {Array.from({ length: n }, (_, i) => {
        const x0 = R() * 1080;
        const v = (140 + R() * 200) * speed;
        const ph = R() * 2100;
        const w = 16 + R() * 18;
        const h = 9 + R() * 8;
        const spin = R() * 360;
        const flip = Math.abs(Math.cos(t * (2 + R() * 3) + i));
        const y = ((ph + t * v) % 2100) - 120;
        const x = x0 + Math.sin(t * 1.4 + i) * 40;
        return <rect key={i} x={f(-w / 2)} y={f((-h * flip) / 2)} width={f(w)} height={f(Math.max(1, h * flip))} fill={colors[i % colors.length]} transform={`translate(${f(x)} ${f(y)}) rotate(${f(spin + t * 160)})`} />;
      })}
    </g>
  );
};

/** A sky of small stars over the box 1080 x h: `n` dots from `seed`, radius rBase + R * rVar, opacity opBase + R * opVar. */
export const StarField: React.FC<{ n: number; seed: number; h: number; color?: string; rBase?: number; rVar?: number; opBase?: number; opVar?: number }> = ({ n, seed, h, color = "#f6efd8", rBase = 0.8, rVar = 2.2, opBase = 0.2, opVar = 0.6 }) => {
  const R = lib.rng(seed) as () => number;
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <circle key={i} cx={f(R() * 1080)} cy={f(R() * h)} r={f(rBase + R() * rVar)} fill={color} opacity={f(opBase + R() * opVar)} />
      ))}
    </>
  );
};

/** Cut-out lettering (Fraunces 900 by default): `y` is the baseline, centred by default. */
export const Word: React.FC<{ x: number; y: number; text: string; size: number; fill?: string; font?: string; weight?: number; italic?: boolean; anchor?: "start" | "middle" | "end"; ls?: number; shadow?: boolean }> = ({ x, y, text, size, fill = "#f7eedb", font, weight, italic, anchor, ls, shadow }) => {
  const sid = useSceneId();
  return (
  <g filter={shadow === false ? "none" : `url(#paper-cut-${sid})`}>
    <text x={f(x)} y={f(y)} textAnchor={anchor || "middle"} fontFamily={font || "Fraunces"} fontWeight={weight || 900} fontStyle={italic ? "italic" : "normal"} fontSize={f(size)} fill={fill} letterSpacing={ls || 0}>{text}</text>
  </g>
  );
};

const CREAM: GradStops = [[0, "#f7eedb"], [1, "#e3d2ae"]];
const back = (x0: number) => {
  const x = Math.max(0, Math.min(1, x0));
  return 1 + 2.7 * Math.pow(x - 1, 3) + 1.7 * Math.pow(x - 1, 2);
};
/** A paper card with a word on it, scaling in with a small overshoot (k 0..1, nothing is drawn at 0). */
export const Card: React.FC<{ k: number; x0: number; y0: number; x1: number; y1: number; text: string; size: number; rot?: number; seed?: number; fill?: string; italic?: boolean; font?: string; weight?: number; ls?: number }> = ({ k, x0, y0, x1, y1, text, size, rot = -2, seed = 9, fill = "#1a1626", italic, font, weight, ls }) => {
  if (k <= 0) return null;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return (
    <g transform={`translate(${cx} ${cy}) rotate(${rot}) scale(${back(k).toFixed(3)}) translate(${-cx} ${-cy})`}>
      <Layer pts={[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]} fill="#efe2c6" amp={3.5} seed={seed} grad={CREAM} />
      <Word x={cx} y={cy + size * 0.36} text={text} size={size} fill={fill} shadow={false} italic={italic} font={font} weight={weight} ls={ls} />
    </g>
  );
};

// ---- characters ----
const DARK = lib.DARK as Record<string, string | null>;
const SilFilter: React.FC<{ id: string; dark: string; rim: string; dx: number; dy: number; glow: number }> = ({ id, dark, rim, dx, dy, glow }) => (
  <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
    <feFlood floodColor={rim} result="r" />
    <feComposite in="r" in2="SourceAlpha" operator="in" result="rs" />
    <feOffset in="rs" dx={dx} dy={dy} result="ro" />
    <feGaussianBlur in="ro" stdDeviation={glow} result="rb" />
    <feFlood floodColor={dark} result="d" />
    <feComposite in="d" in2="SourceAlpha" operator="in" result="ds" />
    <feMerge>
      <feMergeNode in="rb" />
      <feMergeNode in="ds" />
    </feMerge>
  </filter>
);
/** Silhouette light: the shape is filled with `dark`, with a rim of `rim` on the side the offset (dx, dy) points to. */
export type Rim = { dark?: string; rim?: string; dx?: number; dy?: number; glow?: number };
const rimOf = (r: Rim = {}) => ({ dark: r.dark ?? "#0b1020", rim: r.rim ?? "#ffd97a", dx: r.dx ?? -4, dy: r.dy ?? -3, glow: r.glow ?? 1.5 });

/**
 * A full-body backlit silhouette from the puppet rig. Give it an `id` so a <Follow> can hold a candle or a lamp at its hand. `look` adds puppet
 * options over the all-black look (for example { cap: "#000", beard: true, legs: "pants" }); `act` is the puppet's pose and place, as for Puppet.
 */
export const Figure: React.FC<{ id?: string; look?: Record<string, string | number | boolean | null>; rim?: Rim; act: (t: number) => PuppetFrame }> = ({ id, look, rim, act }) => {
  const r = rimOf(rim);
  const sid = useSceneId();
  const fid = hid("sil", sid + JSON.stringify(r));
  return (
    <g filter={`url(#${fid})`}>
      <SilFilter id={fid} {...r} />
      <Puppet id={id} options={{ ...(DARK as Record<string, string | null>), ...(look ?? {}) } as Record<string, string | number | boolean | null>} act={act} />
    </g>
  );
};
/** A man in profile facing right (swept-back hair, glasses, suit). Origin near the ear; head top at y - 178, shoulders end at y + 330 (times s). */
export const Profile: React.FC<{ x: number; y: number; s?: number; dir?: 1 | -1; rim?: Rim; glint?: string }> = ({ x, y, s = 1, dir = 1, rim, glint }) => {
  const r = rimOf(rim ?? { dark: "#0b1020", rim: "#ffd97a", dx: 4, dy: -3, glow: 1.5 });
  const sid = useSceneId();
  const fid = hid("sil", sid + JSON.stringify(r));
  const PR = lib.PROFILE as Record<string, string>;
  return (
    <g transform={`translate(${f(x)} ${f(y)}) scale(${dir * s} ${s})`}>
      <SilFilter id={fid} {...r} />
      <g filter={`url(#${fid})`}>
        <path d={PR.suit} />
        <path d={PR.head} />
        <path d={PR.lens} />
        <path d={PR.arm} />
      </g>
      {glint ? <path d="M 82 -64 L 86 -48" stroke={glint} strokeWidth={3} strokeLinecap="round" opacity={0.9} fill="none" /> : null}
    </g>
  );
};
export type { Pose, PoseName };
