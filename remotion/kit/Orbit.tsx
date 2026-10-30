import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { orbitPoint, resolveBodies, type OrbitBody, type OrbitPreset } from "./helpers";
import { theme } from "./theme";

export type OrbitProps = {
  title?: string;
  preset: OrbitPreset;
  center?: string;
  bodies?: OrbitBody[];
};

const SIZE = theme.width - 2 * theme.safe.side; // square stage inside the side margins
const MAX_R = SIZE / 2 - 90; // leaves room for the outer body's label

export const Orbit: React.FC<OrbitProps> = ({ title, preset, center, bodies }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const list = resolveBodies(preset, bodies);
  const rMax = Math.max(...list.map((b) => b.radius), 1);
  const centerLabel = center ?? (preset === "solar_system" ? "Sun" : preset === "moon_earth" ? "Earth" : undefined);
  return (
    <AbsoluteFill style={{ background: theme.palette.bg, fontFamily: theme.fonts.ui, color: theme.palette.text }}>
      {title ? (
        <div style={{ position: "absolute", top: theme.safe.top, left: theme.safe.side, right: theme.safe.side, fontSize: 56, fontWeight: 700 }}>{title}</div>
      ) : null}
      <svg width={SIZE} height={SIZE} viewBox={`${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`} style={{ position: "absolute", left: theme.safe.side, top: 640 }}>
        {list.map((b, i) => {
          const rx = (b.radius / rMax) * MAX_R;
          const ry = rx * 0.9;
          const [x, y] = orbitPoint(frame, fps, b.periodS, rx, ry, i * 1.3);
          return (
            <g key={i}>
              <ellipse rx={rx} ry={ry} fill="none" stroke={theme.palette.muted} strokeOpacity={0.5} strokeWidth={2} strokeDasharray="6 10" />
              <circle cx={x} cy={y} r={18} fill={theme.palette.accent} />
              <text x={x} y={i % 2 ? y + 52 : y - 28} textAnchor="middle" fontSize={32} fontWeight={600} fill={theme.palette.text} stroke={theme.palette.bg} strokeWidth={6} paintOrder="stroke">
                {b.label}
              </text>
            </g>
          );
        })}
        <circle r={36} fill={theme.palette.bubbleMe} />
        {centerLabel ? (
          <text y={72} textAnchor="middle" fontSize={32} fontWeight={600} fill={theme.palette.muted}>
            {centerLabel}
          </text>
        ) : null}
      </svg>
    </AbsoluteFill>
  );
};
