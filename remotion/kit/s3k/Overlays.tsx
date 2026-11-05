// Captions and overlays. <Captions> is a plain HTML layer drawn OVER the 3D canvas (white bold text on a dark rounded pill, like the
// reference videos), timed per shot, with an ease in and out. <Ruler> is a 3D measuring line with a text label.
import React, { useMemo } from "react";
import type {} from "@react-three/fiber"; // loads the JSX types for <primitive>
import * as THREE from "three";
import { smooth } from "./rng";
import { useStable, useT } from "./time";

export type CaptionItem = { from: number; to: number; text: string };

const FONT = "'Arial Rounded MT Bold', 'Avenir Next Condensed', 'Helvetica Neue', Arial, sans-serif";

/** Opacity and slide for a caption at time t: eases in over 0.35 s and out over 0.3 s; 0 outside [from, to]. Pure. */
export function captionPhase(t: number, from: number, to: number): { active: boolean; k: number; alpha: number } {
  if (t < from || t >= to) return { active: false, k: 0, alpha: 0 };
  const k = smooth((t - from) / 0.35);
  return { active: true, k, alpha: Math.min(k, smooth((to - t) / 0.3)) };
}

/** The caption pill for the current time. Put it as a sibling AFTER the 3D canvas. Keep texts under ~32 characters (one or two lines). */
export const Captions: React.FC<{ items: readonly CaptionItem[]; /** Distance from the top in px (1920 tall frame). Default 170. */ top?: number; /** Font size px, default 84. */ size?: number }> = ({ items, top = 170, size = 84 }) => {
  const t = useT();
  const it = items.find((c) => t >= c.from && t < c.to);
  if (!it) return null;
  const { k, alpha } = captionPhase(t, it.from, it.to);
  return (
    <div style={{ position: "absolute", left: 60, right: 60, top, display: "flex", justifyContent: "center", opacity: alpha, transform: `translateY(${(1 - k) * 18}px) scale(${0.92 + 0.08 * k})` }}>
      <div style={{ background: "rgba(24,24,26,0.94)", color: "#fff", fontFamily: FONT, fontWeight: 900, fontSize: size, lineHeight: `${Math.round(size * 1.14)}px`, padding: "16px 48px 22px", borderRadius: 38, letterSpacing: 1, textAlign: "center", boxShadow: "0 10px 30px rgba(0,0,0,0.28)", border: "3px solid rgba(255,255,255,0.12)" }}>{it.text}</div>
    </div>
  );
};

export type RulerProps = { from: [number, number, number]; to: [number, number, number]; label: string; color?: string; /** Line thickness in metres (default 0.12). */ width?: number; /** Label height in metres (default 1.6). */ labelSize?: number };

/** A measuring line between two points with end ticks and a text label above its middle (the label always faces the camera). */
export const Ruler: React.FC<RulerProps> = (props) => {
  const p = useStable(props);
  const obj = useMemo(() => {
    const g = new THREE.Group();
    const a = new THREE.Vector3(...p.from), b = new THREE.Vector3(...p.to), w = p.width ?? 0.12;
    const mat = new THREE.MeshBasicMaterial({ color: p.color ?? "#ffcf33", toneMapped: false });
    const d = b.clone().sub(a), len = d.length();
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(w, w, len, 8), mat);
    bar.position.copy(a).addScaledVector(d, 0.5); bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    g.add(bar);
    for (const e of [a, b]) { const tick = new THREE.Mesh(new THREE.SphereGeometry(w * 2.2, 10, 8), mat); tick.position.copy(e); g.add(tick); }
    const c = document.createElement("canvas"); c.width = 512; c.height = 128;
    const x = c.getContext("2d")!;
    x.fillStyle = "rgba(24,24,26,0.92)"; x.beginPath(); x.roundRect(4, 4, 504, 120, 40); x.fill();
    x.fillStyle = "#fff"; x.font = "900 72px Arial, Helvetica, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(p.label, 256, 68);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, toneMapped: false, depthTest: false, transparent: true }));
    const h = p.labelSize ?? 1.6; sp.scale.set(h * 4, h, 1);
    sp.position.copy(a).addScaledVector(d, 0.5); sp.position.y += h * 0.9; sp.renderOrder = 20;
    g.add(sp);
    g.traverse((o) => { o.userData.noAO = true; });
    return g;
  }, [p]);
  return <primitive object={obj} />;
};
