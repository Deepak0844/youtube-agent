import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { NODE_KINDS } from "../../src/shared/scene/kinds/network";
import { enterProgress, networkLayout, packetT } from "./drawnHelpers";
import { theme } from "./theme";

export type NetworkProps = {
  nodes: { id: string; type: (typeof NODE_KINDS)[number]; label: string }[];
  links: { from: string; to: string; packet?: string }[];
};

const A = theme.art;
const TINT: Record<NetworkProps["nodes"][number]["type"], string> = {
  laptop: A.liquid,
  resolver: theme.palette.accent,
  root: A.warn,
  tld: A.blue,
  rack: A.steelLight,
};

const Glyph: React.FC<{ type: NetworkProps["nodes"][number]["type"] }> = ({ type }) => {
  const c = TINT[type];
  if (type === "laptop")
    return (
      <svg width={110} height={80} viewBox="0 0 100 72">
        <rect x="8" y="4" width="84" height="54" rx="6" fill={A.steel} stroke={c} strokeWidth={2} />
        <rect x="16" y="11" width="68" height="40" rx="2" fill={A.ink} />
        {[0, 1, 2].map((i) => (
          <rect key={i} x={23} y={18 + i * 10} width={26 - (i % 2) * 8} height={5} rx={2.5} fill={i === 1 ? A.warn : c} />
        ))}
        <path d="M2 60 L98 60 L90 70 Q88 72 84 72 L16 72 Q12 72 10 70 Z" fill={A.paper} stroke={A.ink} strokeWidth={2} />
      </svg>
    );
  if (type === "rack")
    return (
      <svg width={100} height={115} viewBox="0 0 100 115">
        <rect x="6" y="4" width="88" height="107" rx="10" fill={A.steel} stroke={c} strokeWidth={3} />
        {[0, 1, 2, 3].map((u) => (
          <g key={u}>
            <rect x="14" y={12 + u * 25} width="72" height="19" rx={4} fill={A.steelLight} stroke={c} strokeWidth={1.6} />
            <circle cx={78} cy={21.5 + u * 25} r={3} fill={A.ok} />
          </g>
        ))}
      </svg>
    );
  return (
    <svg width={100} height={100} viewBox="0 0 100 100">
      <rect x="10" y="10" width="80" height="80" rx="16" fill={c} fillOpacity={0.15} stroke={c} strokeWidth={4} />
      {[0, 1, 2].map((i) => (
        <rect key={i} x="26" y={30 + i * 16} width="48" height="10" rx={5} fill={c} opacity={0.88 - i * 0.14} />
      ))}
    </svg>
  );
};

export const Network: React.FC<NetworkProps> = ({ nodes, links }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const pos = networkLayout(nodes.length);
  const at = (id: string) => pos[Math.max(0, nodes.findIndex((n) => n.id === id))];
  return (
    <AbsoluteFill style={{ background: theme.palette.bg }}>
      <svg width={theme.width} height={theme.height} style={{ position: "absolute", left: 0, top: 0 }}>
        {links.map((l, i) => {
          const a = at(l.from);
          const b = at(l.to);
          const t = packetT(frame, i, links.length, durationInFrames);
          return (
            <g key={i}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={t > 0 ? theme.palette.accent : theme.palette.muted} strokeOpacity={t > 0 ? 0.9 : 0.4} strokeWidth={4} strokeDasharray="3 16" strokeLinecap="round" />
              {t > 0 ? <circle cx={a.x + (b.x - a.x) * t} cy={a.y + (b.y - a.y) * t} r={13} fill={A.warn} /> : null}
            </g>
          );
        })}
      </svg>
      {links.map((l, i) => {
        const t = packetT(frame, i, links.length, durationInFrames);
        if (t <= 0 || !l.packet) return null;
        const a = at(l.from);
        const b = at(l.to);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: a.x + (b.x - a.x) * t,
              top: a.y + (b.y - a.y) * t - 48,
              transform: "translateX(-50%)",
              fontFamily: theme.fonts.mono,
              fontWeight: 700,
              fontSize: 28,
              color: A.warn,
              background: theme.palette.surface,
              padding: "4px 12px",
              borderRadius: 8,
              whiteSpace: "nowrap",
            }}
          >
            {l.packet}
          </div>
        );
      })}
      {nodes.map((n, i) => (
        <div
          key={n.id}
          style={{
            position: "absolute",
            left: pos[i].x,
            top: pos[i].y,
            transform: "translate(-50%, -50%)",
            opacity: enterProgress(frame, i),
            textAlign: "center",
          }}
        >
          <div style={{ display: "flex", justifyContent: "center" }}>
            <Glyph type={n.type} />
          </div>
          <div style={{ marginTop: 10, fontFamily: theme.fonts.mono, fontWeight: 600, fontSize: 28, color: theme.palette.text, whiteSpace: "nowrap" }}>{n.label}</div>
        </div>
      ))}
    </AbsoluteFill>
  );
};
