import React, { useMemo } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { inRegion, REGIONS, kitProject, visibleCount, type Region } from "./helpers";
import { theme } from "./theme";
import { WORLD_RINGS } from "./world";

export type MapProps = {
  title?: string;
  region: Region;
  markers: { label: string; lat: number; lon: number }[];
  route: boolean;
  framesPerMarker: number;
};

const W = theme.width - 2 * theme.safe.side;
const H = 960;

export const MapPiece: React.FC<MapProps> = ({ title, region, markers, route, framesPerMarker }) => {
  const frame = useCurrentFrame();
  const land = useMemo(
    () =>
      WORLD_RINGS.map((r) =>
        "M" +
        r
          .split(" ")
          .map((p) => {
            const [lon, lat] = p.split(",").map(Number);
            const [x, y] = kitProject(region, lon, lat, W, H);
            return `${x.toFixed(1)} ${y.toFixed(1)}`;
          })
          .join("L") +
        "Z",
      ).join(""),
    [region],
  );
  const [cx0, cy0] = kitProject(region, REGIONS[region][0], REGIONS[region][3], W, H);
  const [cx1, cy1] = kitProject(region, REGIONS[region][2], REGIONS[region][1], W, H);
  const shown = markers.filter((m) => inRegion(region, m.lon, m.lat));
  const n = visibleCount(frame, framesPerMarker, shown.length);
  const pts = shown.map((m) => kitProject(region, m.lon, m.lat, W, H));
  const routeD = pts.slice(0, n).map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("");
  return (
    <AbsoluteFill style={{ background: theme.palette.bg, fontFamily: theme.fonts.ui, color: theme.palette.text }}>
      {title ? (
        <div style={{ position: "absolute", top: theme.safe.top, left: theme.safe.side, right: theme.safe.side, fontSize: 56, fontWeight: 700 }}>{title}</div>
      ) : null}
      <svg width={W} height={H} style={{ position: "absolute", left: theme.safe.side, top: theme.safe.top + 160 }} viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <clipPath id="box">
            <rect x={cx0} y={cy0} width={cx1 - cx0} height={cy1 - cy0} />
          </clipPath>
        </defs>
        <g clipPath="url(#box)">
          <path d={land} fill={theme.palette.surface} stroke={theme.palette.muted} strokeWidth={1.5} strokeLinejoin="round" />
        </g>
        {route && n > 1 ? <path d={routeD} fill="none" stroke={theme.palette.accent} strokeWidth={5} strokeDasharray="14 10" strokeLinecap="round" /> : null}
        {pts.slice(0, n).map((p, i) => {
          const s = interpolate(frame - i * framesPerMarker, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          const label = shown[i].label;
          const left = p[0] > W * 0.7;
          return (
            <g key={i} transform={`translate(${p[0]} ${p[1]}) scale(${s})`}>
              <circle r={14} fill={theme.palette.accent} stroke={theme.palette.bg} strokeWidth={4} />
              <text x={left ? -24 : 24} y={10} textAnchor={left ? "end" : "start"} fontSize={36} fontWeight={600} fill={theme.palette.text} stroke={theme.palette.bg} strokeWidth={6} paintOrder="stroke">
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};
