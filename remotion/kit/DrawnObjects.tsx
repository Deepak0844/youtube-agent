import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { OBJECT_EMPHASIS, OBJECT_ENTERS, OBJECT_IDS, OBJECT_SLOTS } from "../../src/shared/scene/kinds/drawn_objects";
import { emphasisStyle, enterProgress, enterStyle, objectRows } from "./drawnHelpers";
import { theme } from "./theme";

export type DrawnObjectsProps = {
  objects: {
    object: (typeof OBJECT_IDS)[number];
    label?: string;
    slot?: (typeof OBJECT_SLOTS)[number];
    enter?: (typeof OBJECT_ENTERS)[number];
    emphasis?: (typeof OBJECT_EMPHASIS)[number];
  }[];
};

const A = theme.art;
const stroke = { stroke: A.ink, strokeWidth: 6, strokeLinejoin: "round" as const };

// Each drawing: viewBox aspect (w/h) and the SVG body. Flat shapes only, colours from theme.art.
const DRAWINGS: Record<DrawnObjectsProps["objects"][number]["object"], { w: number; h: number; body: (frame: number) => React.ReactNode }> = {
  jug: {
    w: 160,
    h: 220,
    body: () => (
      <>
        <path d="M 30 30 Q 24 16 40 12 L 70 12 Q 80 12 80 22 L 80 40 Q 128 48 132 110 L 132 178 Q 132 206 104 206 L 46 206 Q 22 206 22 182 L 22 70 Q 22 44 30 30 Z" fill={A.glass} fillOpacity={0.3} {...stroke} stroke={A.glass} />
        <path d="M 30 100 L 128 108 L 128 178 Q 128 200 104 200 L 46 200 Q 26 200 26 180 Z" fill={A.liquid} fillOpacity={0.55} />
      </>
    ),
  },
  measuring_cup: {
    w: 180,
    h: 220,
    body: (f) => (
      <>
        <path d="M 24 20 L 156 20 L 140 196 Q 138 212 122 212 L 58 212 Q 42 212 40 196 Z" fill={A.glass} fillOpacity={0.3} {...stroke} stroke={A.glass} />
        {[1, 2, 3].map((t) => (
          <line key={t} x1={44 + t * 2} y1={196 - t * 48} x2={58 + t * 2} y2={196 - t * 48} stroke={A.glass} strokeWidth={3} />
        ))}
        <path d="M 41 120 L 139 120 L 128 206 Q 120 210 110 210 L 70 210 Q 60 210 58 206 Z" fill={A.liquid} fillOpacity={0.6} />
        <rect x={41} y={117} width={98} height={6} rx={3} fill={A.liquid} opacity={0.7 + 0.3 * Math.sin(f / 6)} />
        <path d="M 156 24 Q 182 30 178 58 Q 174 82 150 86" fill="none" {...stroke} stroke={A.glass} strokeLinecap="round" />
      </>
    ),
  },
  ruler: {
    w: 400,
    h: 90,
    body: () => (
      <>
        <rect x="8" y="10" width="384" height="70" rx="8" fill={A.paper} {...stroke} />
        {Array.from({ length: 21 }).map((_, i) => (
          <line key={i} x1={24 + i * 17.6} y1="10" x2={24 + i * 17.6} y2={i % 5 === 0 ? 52 : 34} stroke={A.ink} strokeWidth={i % 5 === 0 ? 4 : 3} />
        ))}
      </>
    ),
  },
  laptop: {
    w: 400,
    h: 260,
    body: () => (
      <>
        <rect x="44" y="10" width="312" height="204" rx="16" fill={A.steel} {...stroke} />
        <rect x="60" y="26" width="280" height="172" rx="6" fill={A.ink} />
        {[90, 140, 110, 160, 70, 120, 60].map((len, i) => (
          <rect key={i} x={76 + (i % 3) * 14} y={42 + i * 21} width={len} height="9" rx="4.5" fill={i % 3 === 1 ? A.warn : A.liquid} opacity={0.92} />
        ))}
        <path d="M 6 216 L 394 216 L 380 244 Q 378 250 370 250 L 30 250 Q 22 250 20 244 Z" fill={A.paper} {...stroke} />
      </>
    ),
  },
  server_rack: {
    w: 240,
    h: 420,
    body: (f) => (
      <>
        <rect x="6" y="6" width="228" height="408" rx="14" fill={A.steel} {...stroke} />
        {[0, 1, 2, 3, 4].map((u) => (
          <g key={u}>
            <rect x="22" y={22 + u * 78} width="196" height="64" rx="8" fill={A.steelLight} stroke={A.ink} strokeWidth={4} />
            {[0, 1, 2].map((l) => (
              <circle key={l} cx={182 + l * 12} cy={54 + u * 78} r="4.6" fill={A.ok} opacity={(f + u * 7 + l * 11) % 30 < 20 ? 1 : 0.28} />
            ))}
            <rect x="36" y={68 + u * 78} width="70" height="5" rx="2.5" fill={A.ink} opacity={0.5} />
          </g>
        ))}
      </>
    ),
  },
  container: {
    w: 400,
    h: 200,
    body: () => (
      <>
        <rect x="8" y="8" width="384" height="184" rx="8" fill={A.blue} {...stroke} />
        {Array.from({ length: 17 }).map((_, i) => (
          <line key={i} x1={36 + i * 21.6} y1="16" x2={36 + i * 21.6} y2="184" stroke={A.ink} strokeOpacity={0.2} strokeWidth="5" />
        ))}
        <rect x="8" y="8" width="26" height="184" fill={A.ink} fillOpacity={0.25} />
        <rect x="366" y="8" width="26" height="184" fill={A.ink} fillOpacity={0.25} />
      </>
    ),
  },
  cloud: {
    w: 300,
    h: 200,
    body: () => (
      <>
        <path d="M 70 170 Q 18 168 20 124 Q 22 88 64 86 Q 70 40 124 38 Q 168 34 188 70 Q 236 62 252 104 Q 284 112 278 144 Q 272 172 236 170 Z" fill={A.cloud} {...stroke} />
        <path d="M 70 128 Q 100 112 130 128 M 150 112 Q 178 98 206 114" fill="none" stroke={A.glass} strokeWidth="6" strokeLinecap="round" />
      </>
    ),
  },
  padlock: {
    w: 100,
    h: 100,
    body: () => (
      <>
        <path d="M30 42 V28 Q30 10 50 10 Q70 10 70 28 V42" fill="none" stroke={A.liquid} strokeWidth={9} strokeLinecap="round" />
        <rect x="18" y="42" width="64" height="46" rx={10} fill={A.liquid} stroke={A.ink} strokeWidth={5} />
        <circle cx="50" cy="63" r={6} fill={A.ink} />
      </>
    ),
  },
};

export const DrawnObjects: React.FC<DrawnObjectsProps> = ({ objects }) => {
  const frame = useCurrentFrame();
  const aligned = (slot: "left" | "center" | "right") => objectRows(objects.length, slot);
  return (
    <AbsoluteFill style={{ background: theme.palette.bg }}>
      {objects.map((o, i) => {
        const d = DRAWINGS[o.object];
        const { x, ys, rowH } = aligned(o.slot ?? "center");
        const labelH = o.label ? 68 : 0;
        const w = Math.min(380, ((rowH - 40 - labelH) * d.w) / d.h);
        const en = enterStyle(o.enter ?? "fade", enterProgress(frame, i));
        const em = emphasisStyle(o.emphasis ?? "none", frame);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: ys[i],
              width: w,
              transform: `translate(-50%, -50%) translateY(${en.dy}px) scale(${en.scale * em.scale}) rotate(${em.rot}deg)`,
              opacity: en.opacity,
              textAlign: "center",
            }}
          >
            <svg viewBox={`0 0 ${d.w} ${d.h}`} style={{ width: "100%", display: "block", overflow: "visible" }}>
              {d.body(frame)}
            </svg>
            {o.label ? (
              <div style={{ marginTop: 14, fontFamily: theme.fonts.mono, fontSize: 44, fontWeight: 700, color: theme.palette.text, whiteSpace: "nowrap" }}>{o.label}</div>
            ) : null}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
