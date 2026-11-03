import React, { useMemo } from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { hashString, lookBg } from "./look";
import { Headline, useInk, useLook } from "./LookParts";
import { animAt, diagOf, drawFrames, parseAnim, sanitizeSvg, stepAt, type SvgNode } from "./svgLogic";
import { theme } from "./theme";
import type { Ink } from "./ink";

export type SvgDiagramProps = {
  title: string;
  svg: string;
  steps?: { at: number; caption?: string }[];
};

const STAGE = theme.width - 2 * theme.safe.side; // square stage; the 1000 viewBox is scaled to it
const TOP = 380;

function paint(v: string, accent: string, pfx: string, ink: Ink): string {
  if (v === "currentColor" || v === "accent") return accent;
  const t: Record<string, string> = { text: ink.text, muted: ink.muted, ok: theme.art.ok, warn: theme.art.warn, blue: theme.art.blue, surface: ink.surface };
  if (Object.hasOwn(t, v)) return t[v]!;
  return v.startsWith("url(#") ? `url(#${pfx}${v.slice(5)}` : v;
}
const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const COLOR_ATTRS = new Set(["fill", "stroke", "stop-color", "marker-start", "marker-mid", "marker-end"]);
type Env = { frame: number; fps: number; accent: string; pfx: string; ink: Ink };

/** Builds React elements from the allow-listed tree. Only validated names and values reach the DOM. */
function build(n: SvgNode, key: string, o: Env): React.ReactNode {
  const props: Record<string, unknown> = { key };
  for (const [k, v] of Object.entries(n.attrs)) {
    if (k.startsWith("data-") || k === "xmlns") continue;
    if (k === "id") props.id = o.pfx + v;
    else if (k === "font-family") props.fontFamily = /mono/i.test(v) ? theme.fonts.mono : theme.fonts.ui;
    else if (COLOR_ATTRS.has(k)) props[camel(k)] = paint(v, o.accent, o.pfx, o.ink);
    else props[camel(k)] = v;
  }
  const a = parseAnim(n.attrs);
  const pop = a?.type === "pop" ? spring({ frame: o.frame - a.delay, fps: o.fps, config: { damping: 12, stiffness: 140 } }) : 1;
  const st = animAt(a, o.frame, pop, drawFrames(diagOf(n)));
  if (a?.type === "draw" && st.draw !== null) {
    props.pathLength = 1;
    props.strokeDasharray = 1;
    props.strokeDashoffset = 1 - st.draw;
    props.fillOpacity = st.draw;
    if (st.opacity === 0) props.opacity = 0;
  }
  const kids = n.kids.map((c, i) => (typeof c === "string" ? c : build(c, `${key}.${i}`, o)));
  if (!a || a.type === "draw") return React.createElement(n.tag, props, ...kids);
  // Pop, fade, move and pulse sit on a wrapper so the element keeps its own transform attribute.
  const style = { opacity: st.opacity, transform: `translate(${st.dx}px, ${st.dy}px) scale(${st.scale})`, transformBox: "fill-box", transformOrigin: "center" } as React.CSSProperties;
  return (
    <g key={key} style={style}>
      {React.createElement(n.tag, { ...props, key: "el" }, ...kids)}
    </g>
  );
}

export const SvgDiagram: React.FC<SvgDiagramProps> = ({ title, svg, steps }) => {
  const frame = useCurrentFrame();
  const ink = useInk();
  const { fps, durationInFrames } = useVideoConfig();
  const look = useLook();
  // Defence in depth: the same sanitizer as at build time. If it fails, nothing from the string is rendered.
  const res = useMemo(() => sanitizeSvg(svg), [svg]);
  const head = (
    <div style={{ position: "absolute", top: theme.safe.top, left: theme.safe.side, right: theme.safe.side }}>
      <Headline text={title} size={64} />
    </div>
  );
  if (!res.ok) return <AbsoluteFill style={{ background: lookBg, fontFamily: theme.fonts.ui, color: ink.text }}>{head}</AbsoluteFill>;
  const o: Env = { frame, fps, accent: look.accent, ink, pfx: `d${hashString(svg)}-` };
  const k = steps?.length ? stepAt(steps, frame / Math.max(1, durationInFrames)) : -1;
  const caption = k >= 0 ? steps![k]!.caption : undefined;
  return (
    <AbsoluteFill style={{ background: lookBg, fontFamily: theme.fonts.ui, color: ink.text }}>
      {head}
      <svg width={STAGE} height={STAGE} viewBox="0 0 1000 1000" fill="none" style={{ position: "absolute", left: theme.safe.side, top: TOP, overflow: "hidden" }} fontFamily={theme.fonts.ui}>
        {res.root.kids.map((c, i) => (typeof c === "string" ? null : build(c, String(i), o)))}
      </svg>
      {caption ? (
        <div style={{ position: "absolute", top: TOP + STAGE + 24, left: theme.safe.side, right: theme.safe.side, fontSize: 48, fontWeight: 700, textAlign: "center", color: look.accent2 }}>{caption}</div>
      ) : null}
    </AbsoluteFill>
  );
};
