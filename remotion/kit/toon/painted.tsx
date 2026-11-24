import React, { useLayoutEffect, useRef } from "react";
import paintedFactory from "./upstream/painted.js";
import { registry } from "./comic";
import { useRuntime, useToonBuild } from "./Stage";

// yt-toon/painted: the soft hand-painted storybook look of cartoon-shorts (styles/painted.js): big cumulus clouds, layered green hills, a warm kitchen
// with window light, a round friendly cook and glossy food. The drawing is cartoon-shorts' own code; each piece below is one of its builders.
// Pieces draw into their own group, in the order you write them (later pieces are on top). Positions are stage units (1080 x 1920).

/* eslint-disable @typescript-eslint/no-explicit-any */
const lib: any = (() => {
  const w: Record<string, unknown> = {};
  paintedFactory(w, {} as Document); // the colour and random helpers are pure; nothing is drawn until a piece is built inside a film
  return w.Painted;
})();
const usePainted = (): any => useRuntime().win.Painted;

/** Blend two 6-digit hex colours: mixColor("#fbeec8", "#f0c060", 0.5). */
export const mixColor = (a: string, b: string, k: number): string => lib.mix(a, b, k);

// the twirled nest of a few broad glossy bands with sauce on top: cartoon-shorts' painted example (a hero plate of pasta)
function pastaNest(P: any, p: Element, { w = 300, h = 120, turns = 3, seed = 4, basil = true }: { w?: number; h?: number; turns?: number; seed?: number; basil?: boolean } = {}) {
  const { E, lin, rad, blur } = P;
    const g = E('g', {}, p), hw = w / 2, bw = w * .13, r = P.rng(seed), R = Math.PI * 2 * turns;
    E('ellipse', { cx: 0, cy: hw * .14, rx: hw * 1.02, ry: hw * .36, fill: '#5a2a10', opacity: .28, filter: blur(p, 6) }, g);
    // the mound under the bands, shaded darker at the bottom: the gaps between bands read as pasta in shadow
    E('path', { d: `M${-hw * .9},${hw * .12} C${-hw * .96},${-h * .95} ${hw * .96},${-h * .95} ${hw * .9},${hw * .12} C${hw * .5},${hw * .4} ${-hw * .5},${hw * .4} ${-hw * .9},${hw * .12}Z`,
      fill: lin(p, [[0, '#e6a050'], [1, '#a95a24']]), stroke: '#7a3a16', 'stroke-width': 3 }, g);
    // one spiral from the outer ring (low, wide) to the top (small, high); each half-turn is a band
    const pt = (th: number) => {
      const k = th / R, rx = hw * (.84 - .56 * k), cy = -h * .7 * Math.sin(k * Math.PI / 2);
      return [rx * Math.cos(th + .5), cy + rx * .42 * Math.sin(th + .5)];
    };
    const halves = Math.ceil(turns * 2), bands: any[] = [];
    for (let j = 0; j < halves; j++) {
      const a = j * Math.PI, b = Math.min((j + 1) * Math.PI, R), pts: number[][] = [];
      for (let i = 0; i <= 18; i++) pts.push(pt(a + (b - a) * i / 18));
      bands.push({ d: 'M' + pts.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' L'), front: j % 2 === 0, k: j / halves });
    }
    // back halves first, then front halves bottom to top: the front of every ring sits over the back of the ring below
    [...bands.filter((x: any) => !x.front), ...bands.filter((x: any) => x.front)].forEach(({ d, front, k }: any) => {
      E('path', { d, fill: 'none', stroke: '#7a3a16', 'stroke-width': bw + 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      E('path', { d, fill: 'none', stroke: front ? P.mix('#eeac58', '#f6c878', k) : '#d0883e', 'stroke-width': bw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      E('path', { d, fill: 'none', stroke: front ? '#ffe2a6' : '#e8a85c', 'stroke-width': bw * .3, 'stroke-linecap': 'round', transform: `translate(0,${(-bw * .24).toFixed(1)})`, opacity: .9 }, g);
      if (front) E('path', { d, fill: 'none', stroke: '#fffaf0', 'stroke-width': bw * .14, 'stroke-linecap': 'round', 'stroke-dasharray': `${(w * .05).toFixed(0)} ${(w * .45).toFixed(0)}`, 'stroke-dashoffset': (r() * w * .4).toFixed(0), transform: `translate(0,${(-bw * .3).toFixed(1)})` }, g);
    });
    // the sauce: a glossy red pool on the top of the twirl, lobes running down over the bands, small tomato chunks and glints
    const sy = -h * .7, sw = w * .3;
    E('path', { d: `M${-sw},${sy} C${-sw},${sy - sw * .38} ${sw},${sy - sw * .42} ${sw},${sy} C${sw * 1.04},${sy + sw * .34} ${sw * .78},${sy + sw * .7} ${sw * .56},${sy + sw * .36} C${sw * .36},${sy + sw * .5} ${sw * .1},${sy + sw * .74} ${-sw * .08},${sy + sw * .4} C${-sw * .3},${sy + sw * .62} ${-sw * .62},${sy + sw * .66} ${-sw * .72},${sy + sw * .3} C${-sw * .86},${sy + sw * .34} ${-sw * 1.02},${sy + sw * .2} ${-sw},${sy}Z`,
      fill: rad(p, [[0, '#f0623a'], [.6, '#cf3a22'], [1, '#9c2414']], .42, .38, .7), stroke: '#7a1c10', 'stroke-width': 2.6, 'stroke-linejoin': 'round' }, g);
    [[-.6, .06, .11], [-.05, -.12, .13], [.5, .1, .1], [.18, .28, .08], [-.38, .3, .07]].forEach(([fx, fy, fr]: number[], i: number) => {
      const x = sw * fx, y = sy + sw * fy, cr = sw * fr * 1.8, q = i * 47 - 40;
      E('path', { d: `M${-cr},0 C${-cr},${-cr * .8} ${cr * .9},${-cr * .9} ${cr},${-cr * .1} C${cr * 1.1},${cr * .6} ${-cr * .6},${cr * .8} ${-cr},0Z`, transform: `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${q})`, fill: i % 2 ? '#e14a2a' : '#ee6a44', stroke: '#9a2414', 'stroke-width': 1.4 }, g);
      E('path', { d: `M${(x - cr * .6).toFixed(1)},${(y - cr * .2).toFixed(1)} q${(cr * .4).toFixed(1)},${(-cr * .45).toFixed(1)} ${(cr * .9).toFixed(1)},${(-cr * .35).toFixed(1)}`, fill: 'none', stroke: '#fff', 'stroke-width': Math.max(1.5, cr * .18).toFixed(1), opacity: .8, 'stroke-linecap': 'round' }, g);
    });
    E('path', { d: `M${-sw * .7},${sy - sw * .14} C${-sw * .4},${sy - sw * .3} ${-sw * .05},${sy - sw * .32} ${sw * .2},${sy - sw * .28}`, fill: 'none', stroke: '#fff', 'stroke-width': w * .016, opacity: .7, 'stroke-linecap': 'round' }, g);
    if (basil) [[-.1, -1, -28], [.28, -.8, 34]].forEach(([fx, fy, rot]: number[]) => {
      const lf = E('g', { transform: `translate(${(sw * fx * 1.6).toFixed(1)},${(sy + sw * .1 * fy - sw * .22).toFixed(1)}) rotate(${rot}) scale(${(w / 300).toFixed(3)})` }, g);
      E('path', { d: 'M0,0 C10,-18 34,-22 52,-6 C34,10 12,10 0,0Z', fill: lin(p, [[0, '#6cbf4e'], [1, '#2f7a2a']]), stroke: '#1f4a18', 'stroke-width': 2.2, 'stroke-linejoin': 'round' }, lf);
      E('path', { d: 'M4,-1 C18,-6 32,-7 46,-5', fill: 'none', stroke: '#a8e08a', 'stroke-width': 2, 'stroke-linecap': 'round' }, lf);
      E('path', { d: 'M14,-10 C22,-14 30,-14 36,-12', fill: 'none', stroke: '#fff', 'stroke-width': 2.6, opacity: .7, 'stroke-linecap': 'round' }, lf);
    });
    return g;
  }


/** A piece that calls a painted builder once into its own <g>; the builder's update function (when it has one) runs every frame. */
function build<P extends object>(make: (Pt: any, g: Element, props: P) => any, name: string): React.FC<P> {
  const C: React.FC<P> = (props) => {
    const ref = useRef<SVGGElement>(null);
    const rt = useRuntime();
    useToonBuild(() => {
      const r = make(rt.win.Painted, ref.current as Element, props);
      const upd = typeof r === "function" ? r : r && typeof r.update === "function" ? (t: number) => r.update(t) : null;
      if (upd) rt.short.ups.push(upd);
    });
    return <g ref={ref} />;
  };
  C.displayName = name;
  return C;
}

/** The full 1080 x 1920 meadow: sky, sun glow, clouds, mountains, hills, village, flowers and sheep; clouds drift and sheep hop. */
export const Landscape = build<{ sheepOn?: boolean; seed?: number }>((P, g, p) => P.landscape(g, { sheepOn: p.sheepOn ?? true, seed: p.seed ?? 3 }), "Landscape");
/** The warm kitchen: wall, beam, window with a live landscape, curtains, shelf, tiles. hang: false hides the cured meats on hooks. Draw the Counter after the Cook. */
export const Kitchen = build<{ counterY?: number; hang?: boolean }>((P, g, p) => P.kitchen(g, { counterY: p.counterY ?? 1240, hang: p.hang ?? true }), "Kitchen");
/** The wooden counter top and front from y to the bottom of the frame. */
export const Counter = build<{ y?: number }>((P, g, p) => void P.counter(g, p.y ?? 1240), "Counter");
export const Cloud = build<{ x: number; y: number; s?: number; seed?: number }>((P, g, p) => void P.cloud(g, p.x, p.y, p.s ?? 1, p.seed ?? 1), "Cloud");
export const Sheep = build<{ x: number; y: number; s?: number; flip?: 1 | -1 }>((P, g, p) => void P.sheep(g, p.x, p.y, p.s ?? 1, p.flip ?? 1), "Sheep");
export const Village = build<{ x: number; y: number; s?: number }>((P, g, p) => void P.village(g, p.x, p.y, p.s ?? 1), "Village");

// ---- the cook ----
/** Arm angles [a1, a2] in degrees: a1 swings the upper arm out from straight down, a2 bends the elbow. Arms up: [150, 50]. */
export type CookFrame = {
  la?: [number, number];
  ra?: [number, number];
  headR?: number;
  /** 0..1 mouth, or "voice" to open it while a narration line plays */
  talk?: number | "voice";
  /** true closes the eyes, or "auto" blinks every 3.4 s */
  blink?: boolean | "auto";
  happy?: boolean;
  point?: "l" | "r" | null;
  bob?: number;
  lean?: number;
};
/**
 * The round friendly cook. At s = 1 the hair top is about y - 362, the shoulders at (x +- 142, y + 80), the body ends at y + 640. act(t) gives the
 * arms, face and bounce for each frame. Give it an id so a Follow can hold a spoon in its hand (at hand = right, fhand = left).
 */
export const Cook: React.FC<{ id?: string; x?: number; y?: number; s?: number; skin?: string; hair?: string; top?: string; apron?: string; trim?: string; act: (t: number) => CookFrame }> = ({ id, x = 540, y = 900, s = 1, skin, hair, top, apron, trim, act }) => {
  const ref = useRef<SVGGElement>(null);
  const rt = useRuntime();
  const actRef = useRef(act);
  useLayoutEffect(() => {
    actRef.current = act;
  });
  useToonBuild(() => {
    const P = rt.win.Painted;
    const cook = P.Cook(ref.current, { x, y, s, skin, hair, top, apron, trim });
    let bob = 0;
    if (id) {
      registry(rt).set(id, {
        at: (j: string) => {
          const h = j === "fhand" ? cook.hands.l : cook.hands.r;
          return [x + s * h[0], y + bob + s * h[1]];
        },
      });
    }
    rt.short.ups.push((t: number) => {
      const f = actRef.current(t);
      bob = f.bob ?? 0;
      cook.set({ ...f, talk: f.talk === "voice" ? P.talkAt(t) : f.talk, blink: f.blink === "auto" ? P.blinkAt(t) : f.blink });
    });
  });
  return <g ref={ref} />;
};

// ---- food and tools (drawn around 0,0, about 200 px wide: wrap them in a <g transform=...> to place them) ----
export const Tomato = build<{ r?: number }>((P, g, p) => void P.F.tomato(g, p.r ?? 34), "Tomato");
export const Garlic = build<object>((P, g) => void P.F.garlic(g), "Garlic");
export const Onion = build<object>((P, g) => void P.F.onion(g), "Onion");
export const Bacon = build<object>((P, g) => void P.F.bacon(g), "Bacon");
export const Pecorino = build<object>((P, g) => void P.F.pecorino(g), "Pecorino");
export const TomatoTin = build<object>((P, g) => void P.F.can(g), "TomatoTin");
export const SpaghettiPack = build<object>((P, g) => void P.F.spaghetti(g), "SpaghettiPack");
export const Guanciale = build<{ s?: number }>((P, g, p) => void P.F.guanciale(g, p.s ?? 1), "Guanciale");
export const Bottle = build<{ glass?: string; label?: string; s?: number }>((P, g, p) => void P.F.bottle(g, p.glass ?? "#4f8a4a", p.label ?? "#f4ead2", p.s ?? 1), "Bottle");
export const PepperMill = build<{ s?: number }>((P, g, p) => void P.F.pepper(g, p.s ?? 1), "PepperMill");
export const Peppercorns = build<{ n?: number; seed?: number }>((P, g, p) => void P.F.corns(g, p.n ?? 9, p.seed ?? 3), "Peppercorns");
export const SaltPinch = build<{ s?: number }>((P, g, p) => void P.F.salt(g, p.s ?? 1), "SaltPinch");
/** A white plate with a blue band and a soft shadow. */
export const Plate = build<{ rx?: number; ry?: number }>((P, g, p) => void P.F.plate(g, p.rx ?? 250, p.ry ?? 100), "Plate");
/** A heap of many thin strands (for a big hero plate use PastaNest). */
export const Nest = build<{ w?: number; h?: number; seed?: number; sauce?: boolean }>((P, g, p) => void P.F.nest(g, { w: p.w ?? 230, h: p.h ?? 90, seed: p.seed ?? 4, sauce: p.sauce ?? false }), "Nest");
/** A few broad glossy pasta bands twirled into a nest, sauce, tomato chunks and basil on top. */
export const PastaNest = build<{ w?: number; h?: number; turns?: number; seed?: number; basil?: boolean }>((P, g, p) => void pastaNest(P, g, p), "PastaNest");
export const Flames = build<object>((P, g) => P.F.flames(g), "Flames");
/** Soft white wisps of steam rising about 240 px times s; amt 0..1 scales the opacity (change it with time). */
export const Steam: React.FC<{ x: number; y: number; n?: number; s?: number; amt?: number }> = ({ x, y, n = 3, s = 1, amt = 1 }) => {
  const ref = useRef<SVGGElement>(null);
  const rt = useRuntime();
  const amtRef = useRef(amt);
  useLayoutEffect(() => {
    amtRef.current = amt;
  });
  useToonBuild(() => {
    const st = rt.win.Painted.F.steam(ref.current, x, y, n, s);
    rt.short.ups.push((t: number) => st.update(t, amtRef.current));
  });
  return <g ref={ref} />;
};
/** One bacon strip; cook 0..1 goes from raw to golden. */
export const Strip: React.FC<{ s?: number; cook?: number }> = ({ s = 1, cook = 0 }) => {
  const ref = useRef<SVGGElement>(null);
  const rt = useRuntime();
  const cookRef = useRef(cook);
  useLayoutEffect(() => {
    cookRef.current = cook;
  });
  useToonBuild(() => {
    const st = rt.win.Painted.F.strip(ref.current, s);
    rt.short.ups.push(() => st.cook(cookRef.current));
  });
  return <g ref={ref} />;
};
/** A fork lifting a twirl of pasta; lift 0..1. */
export const Twirl: React.FC<{ w?: number; h?: number; seed?: number; sauce?: boolean; lift?: number }> = ({ w, h, seed = 6, sauce = true, lift = 0 }) => {
  const ref = useRef<SVGGElement>(null);
  const rt = useRuntime();
  const liftRef = useRef(lift);
  useLayoutEffect(() => {
    liftRef.current = lift;
  });
  useToonBuild(() => {
    const tw = rt.win.Painted.F.twirl(ref.current, { w, h, seed, sauce });
    rt.short.ups.push(() => tw.update(liftRef.current));
  });
  return <g ref={ref} />;
};

// Containers whose inside is a clipped group: what you put between the tags is drawn inside (an oil pool, sauce, bubbles).
function container(name: string, make: (P: any, g: Element, s: number) => any, slot: "inside" | "water"): React.FC<{ s?: number; children?: React.ReactNode }> {
  const C: React.FC<{ s?: number; children?: React.ReactNode }> = ({ s = 1, children }) => {
    const ref = useRef<SVGGElement>(null);
    const inner = useRef<SVGGElement>(null);
    const rt = useRuntime();
    useToonBuild(() => {
      const r = make(rt.win.Painted, ref.current as Element, s);
      (r[slot] as Element).appendChild(inner.current as Element); // the children's group moves inside the clipped part
    });
    return (
      <>
        <g ref={ref} />
        <g ref={inner}>{children}</g>
      </>
    );
  };
  C.displayName = name;
  return C;
}
/** The iron pan seen from above (ellipse rx 340, ry 160, handle to x + 664 at s = 1). Children are drawn inside it, clipped to the pan. */
export const Pan = container("Pan", (P, g, s) => P.F.pan(g, s), "inside");
/** The stock pot (about x +-300, y -206..210). Children are drawn on the water, clipped to the surface. */
export const Pot = container("Pot", (P, g) => P.F.pot(g), "water");
/** A bowl; children are drawn inside it. */
export const Bowl = container("Bowl", (P, g) => P.F.bowl(g), "inside");
