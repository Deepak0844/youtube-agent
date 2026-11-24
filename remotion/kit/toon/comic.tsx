import React, { useContext, useLayoutEffect, useRef } from "react";
import { useRuntime, useToonBuild } from "./Stage";
import { useSceneId } from "./scene-parts";
import toonFactory from "./upstream/toon.js";
import { ToonContext, type ToonCharacter } from "./context";

// yt-toon/comic: the comic puppets of cartoon-shorts (styles/toon.js). A Puppet is a 2D rig: a pose is a set of joint angles in degrees
// (0 = limb down, 90 = forward, 180 = up), see POSES. `act` is called for every frame with the time in seconds and returns where the
// puppet is and how it stands; it must be a pure function of t.

export type PoseName = "stand" | "ready" | "shoot" | "release" | "block" | "leap" | "layup" | "dunk" | "kneel" | "kneelFace" | "kneelRoar" | "roar" | "flex" | "celebrate" | "sit" | "sitSad" | "carry" | "cradle" | "reach" | "point" | "hold" | "write" | "trophy";
export type FaceName = "neutral" | "focus" | "grit" | "shout" | "roar" | "sad" | "cry" | "smile" | "grin" | "wow" | "worry";
/** Joint angles (degrees) and face of one moment: tor (lean), hd (head tilt), nua/nfa near upper/fore-arm, fua/ffa far, nth/nsh near thigh/shin, fth/fsh far, nft/fft feet, turn (0 side .. 1 front), lift, look, blink, tears, open; face; hand/fhand: "fist" | "open". */
export type Pose = Partial<Record<"tor" | "hd" | "nua" | "nfa" | "fua" | "ffa" | "nth" | "nsh" | "fth" | "fsh" | "nft" | "fft" | "turn" | "lift" | "look" | "blink" | "tears" | "sq" | "open", number>> & { face?: FaceName; hand?: "fist" | "open"; fhand?: "fist" | "open" };

// The pose maths are pure; load them once without a page (no drawing happens until a puppet is built inside a film).
const lib = (() => {
  const w: Record<string, unknown> = {};
  toonFactory(w, {} as Document);
  return w.Toon as { P: Record<PoseName, Pose>; mix: (a: Pose, b: Pose, k: number) => Pose; cycle: (phase: number, amp?: number, kind?: "run" | "walk" | "sprint") => Pose; track: <V>(keys: [number, V, string?][]) => (t: number) => V; EASE: Record<string, (x: number) => number> };
})();
/** Ready-made poses by name. */
export const P = lib.P;
/** Blend two poses: mix(P.stand, P.point, 0.5). */
export const mix = lib.mix;
/** Walk / run / sprint cycle pose for a phase in radians. */
export const cycle = lib.cycle;
/** A value that moves through keys [[seconds, value, ease?], ...] (numbers, arrays or poses). */
export const track = lib.track;
export const EASE = lib.EASE;

/** Pose `over` on top of pose `base`: pose(P.stand, { face: "grin" }). */
export const pose = (base: Pose, over: Pose): Pose => ({ ...base, ...over });

/** Where a puppet is and how it stands at one moment. `dir` -1 faces left; `s` is the scale. */
export type PuppetFrame = { pose: Pose; x: number; y: number; dir?: 1 | -1; s?: number };
export type PuppetOptions = Record<string, string | number | boolean | null>;
/** Joint names a puppet can report: hand, fhand (far hand), head, neck, hip, foot, ffoot, knee, elbow, shoulder, fshoulder. */
export type Joint = "hand" | "fhand" | "head" | "neck" | "hip" | "foot" | "ffoot" | "knee" | "elbow" | "shoulder" | "fshoulder";

// puppets of this film by id, so a <Follow> can find the one it follows (a Follow must be written after its Puppet)
type Rig = { at(j: string): number[] };
const registry = (rt: { win: Record<string, unknown> }): Map<string, Rig> => {
  const w = rt.win as { __puppets?: Map<string, Rig> };
  return (w.__puppets ??= new Map());
};

/**
 * One character. `who` takes the look from the series cast (ref/cast.json); `options` is a one-off look (or overrides): the puppet
 * options of cartoon-shorts (skin, skinD, hair, hairStyle, top, shirt, shirtD, tie, pants, shoe, beard, cap, glasses, kid, build...).
 * `id` lets a <Follow> hold a prop at one of its joints.
 */
export const Puppet: React.FC<{ id?: string; who?: string; options?: PuppetOptions; act: (t: number) => PuppetFrame }> = ({ id, who, options, act }) => {
  const rt = useRuntime();
  const input = useContext(ToonContext);
  const ref = useRef<SVGGElement>(null);
  const actRef = useRef(act);
  useLayoutEffect(() => {
    actRef.current = act;
  });
  useSceneId();
  useToonBuild(() => {
    const member: ToonCharacter | undefined = who ? input?.cast.find((c) => c.name === who) : undefined;
    if (who && !member && !options) throw new Error(`cast: '${who}' is not in the cast (${(input?.cast ?? []).map((c) => c.name).join(", ") || "empty"})`);
    const puppet = new rt.Toon(ref.current, { ...(member?.options ?? {}), ...(options ?? {}) });
    if (id) registry(rt).set(id, puppet);
    rt.short.ups.push((t: number) => {
      const f = actRef.current(t);
      puppet.set({ ...f.pose }, f.x, f.y, f.dir ?? 1, f.s ?? 1, t);
    });
  });
  return <g ref={ref} />;
};

/**
 * Holds its children (a phone, a cup, a letter) at a joint of the puppet with this `id`, drawn where you write it (so put it after
 * the puppet, and after anything that should cover the prop's z-order). `place` gives where it goes at time t: [x, y, scale, rotation].
 * Show or hide the children yourself (style display) for the times the prop is not in hand.
 */
export const Follow: React.FC<{ of: string; at?: Joint; dx?: number; dy?: number; s?: number; r?: number; place?: (t: number, joint: [number, number]) => [number, number, number, number]; children?: React.ReactNode }> = ({ of, at = "hand", dx = 0, dy = 0, s = 1, r = 0, place, children }) => {
  const rt = useRuntime();
  const ref = useRef<SVGGElement>(null);
  const placeRef = useRef(place);
  useLayoutEffect(() => {
    placeRef.current = place;
  });
  useToonBuild(() => {
    rt.short.ups.push((t: number) => {
      const puppet = registry(rt).get(of);
      if (!puppet || !ref.current) return;
      const p = puppet.at(at);
      const q = placeRef.current ? placeRef.current(t, [p[0]!, p[1]!]) : [p[0]! + dx, p[1]! + dy, s, r];
      rt.short.tr(ref.current, q[0], q[1], q[2], q[3]);
    });
  });
  return <g ref={ref}>{children}</g>;
};

/**
 * A line from a joint of the puppet with this `id` to wherever `to` says for time t (a fishing rod, a catching pole), with an optional ring at
 * its tip. Draw it where it should sit in the stack, after the puppet.
 */
export const Tether: React.FC<{ of: string; at?: Joint; to: (t: number, joint: [number, number]) => [number, number]; stroke: string; width: number; tip?: { r: number; stroke: string; width: number } }> = ({ of, at = "hand", to, stroke, width, tip }) => {
  const rt = useRuntime();
  const line = useRef<SVGLineElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const toRef = useRef(to);
  useLayoutEffect(() => {
    toRef.current = to;
  });
  useToonBuild(() => {
    rt.short.ups.push((t: number) => {
      const puppet = registry(rt).get(of);
      if (!puppet || !line.current) return;
      const h = puppet.at(at);
      const e = toRef.current(t, [h[0]!, h[1]!]);
      line.current.setAttribute("x1", String(h[0]));
      line.current.setAttribute("y1", String(h[1]));
      line.current.setAttribute("x2", String(e[0]));
      line.current.setAttribute("y2", String(e[1]));
      if (ring.current) {
        ring.current.setAttribute("cx", String(e[0]));
        ring.current.setAttribute("cy", String(e[1]));
      }
    });
  });
  return (
    <>
      <line ref={line} stroke={stroke} strokeWidth={width} strokeLinecap="round" />
      {tip ? <circle ref={ring} r={tip.r} fill="none" stroke={tip.stroke} strokeWidth={tip.width} /> : null}
    </>
  );
};
