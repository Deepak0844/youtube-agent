import React, { useContext, useRef } from "react";
import { useRuntime, useToonBuild } from "./Stage";
import { useSceneId } from "./core";
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

/** Where a puppet is and how it stands at one moment. `dir` -1 faces left; `s` is the scale. */
export type PuppetFrame = { pose: Pose; x: number; y: number; dir?: 1 | -1; s?: number };
export type PuppetOptions = Record<string, string | number | boolean | null>;
/** A thing the puppet holds or wears at a joint: an SVG child moved with it (e.g. a phone in the hand). `at` is a joint name: hand, fhand, head, neck, hip, foot, ffoot, knee, elbow, shoulder. */
export type Held = { at: "hand" | "fhand" | "head" | "neck" | "hip" | "foot" | "ffoot" | "knee" | "elbow" | "shoulder" | "fshoulder"; dx?: number; dy?: number; s?: number; r?: number | ((t: number) => number); node: React.ReactNode };

/**
 * One character. `who` takes the look from the series cast (ref/cast.json); `options` is a one-off look (or overrides): the puppet
 * options of cartoon-shorts (skin, skinD, hair, hairStyle, top, shirt, shirtD, tie, pants, shoe, beard, cap, glasses, kid, build...).
 */
export const Puppet: React.FC<{ who?: string; options?: PuppetOptions; act: (t: number) => PuppetFrame; held?: Held[] }> = ({ who, options, act, held = [] }) => {
  const rt = useRuntime();
  const input = useContext(ToonContext);
  const ref = useRef<SVGGElement>(null);
  const heldRefs = useRef<(SVGGElement | null)[]>([]);
  const actRef = useRef(act);
  actRef.current = act;
  const heldRef = useRef(held);
  heldRef.current = held;
  useSceneId();
  useToonBuild(() => {
    const member: ToonCharacter | undefined = who ? input?.cast.find((c) => c.name === who) : undefined;
    if (who && !member && !options) throw new Error(`cast: '${who}' is not in the cast (${(input?.cast ?? []).map((c) => c.name).join(", ") || "empty"})`);
    const puppet = new rt.Toon(ref.current, { ...(member?.options ?? {}), ...(options ?? {}) });
    // the held layers draw after the puppet (on top of it), each in its own group moved to the joint every frame
    rt.short.ups.push((t: number) => {
      const f = actRef.current(t);
      puppet.set({ ...f.pose }, f.x, f.y, f.dir ?? 1, f.s ?? 1, t);
      heldRef.current.forEach((h, i) => {
        const el = heldRefs.current[i];
        if (!el) return;
        const p = puppet.at(h.at);
        const r = typeof h.r === "function" ? h.r(t) : (h.r ?? 0);
        rt.short.tr(el, p[0] + (h.dx ?? 0), p[1] + (h.dy ?? 0), h.s ?? 1, r);
      });
    });
  });
  return (
    <>
      <g ref={ref} />
      {held.map((h, i) => (
        <g key={i} ref={(el) => void (heldRefs.current[i] = el)}>
          {h.node}
        </g>
      ))}
    </>
  );
};
