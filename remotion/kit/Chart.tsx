import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { niceMax, pieSlices } from "./helpers";
import { theme } from "./theme";

export type ChartProps = {
  chart: "bar" | "line" | "pie";
  title?: string;
  labels: string[];
  series: { name?: string; values: number[] }[];
  /** Frames the draw-in takes. */
  drawFrames: number;
};

const W = theme.width - theme.safe.side * 2; // 936
const H = 800;
const PAD = { l: 20, r: 20, t: 20, b: 70 };
const color = (i: number) => theme.palette.chart[i % theme.palette.chart.length]!;

export const Chart: React.FC<ChartProps> = ({ chart, title, labels, series, drawFrames }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [0, Math.max(1, drawFrames)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const n = labels.length;
  const top = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + plotH * (1 - v / top);
  const slotW = plotW / n;
  const xc = (i: number) => PAD.l + slotW * (i + 0.5);
  const showLabelsAt = (i: number) => n <= 6 || i % 2 === 0;

  const axes = (
    <>
      <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke={theme.palette.muted} strokeWidth={3} />
      {labels.map((l, i) =>
        showLabelsAt(i) ? (
          <text key={i} x={xc(i)} y={H - 20} textAnchor="middle" fill={theme.palette.muted} fontSize={30} fontFamily={theme.fonts.ui}>
            {l}
          </text>
        ) : null,
      )}
    </>
  );

  let body: React.ReactNode = null;
  if (chart === "bar") {
    const bw = (slotW * 0.7) / series.length;
    body = (
      <>
        {axes}
        {series.map((s, si) =>
          s.values.map((v, i) => {
            const h = (y(0) - y(v)) * t;
            return <rect key={`${si}-${i}`} x={xc(i) - (slotW * 0.7) / 2 + si * bw} y={y(0) - h} width={bw - 4} height={h} rx={6} fill={color(si)} />;
          }),
        )}
      </>
    );
  } else if (chart === "line") {
    body = (
      <>
        {axes}
        {series.map((s, si) => (
          <g key={si}>
            <polyline
              points={s.values.map((v, i) => `${xc(i)},${y(v)}`).join(" ")}
              fill="none"
              stroke={color(si)}
              strokeWidth={8}
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - t}
            />
            {s.values.map((v, i) => (
              <circle key={i} cx={xc(i)} cy={y(v)} r={12} fill={color(si)} opacity={t >= (i + 0.5) / n ? 1 : 0} />
            ))}
          </g>
        ))}
      </>
    );
  } else {
    // Pie: slices sweep clockwise from 12 o'clock as t goes 0 -> 1.
    const r = Math.min(W, H) / 2 - 40;
    const cx = W / 2;
    const cy = H / 2;
    const fr = pieSlices(series[0]?.values ?? []);
    const starts = fr.map((_, i) => fr.slice(0, i).reduce((a, b) => a + b, 0));
    body = (
      <>
        {fr.map((f, i) => {
          const a0 = starts[i]! * 2 * Math.PI * t;
          const a1 = (starts[i]! + f) * 2 * Math.PI * t;
          const p = (a: number) => `${cx + r * Math.sin(a)} ${cy - r * Math.cos(a)}`;
          if (a1 - a0 < 1e-4) return null;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          return <path key={i} d={`M ${cx} ${cy} L ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)} Z`} fill={color(i)} stroke={theme.palette.bg} strokeWidth={4} />;
        })}
      </>
    );
  }

  // Legend: series names for bar/line, labels for pie.
  const legend = chart === "pie" ? labels : series.map((s, i) => s.name ?? `#${i + 1}`);
  return (
    <AbsoluteFill
      style={{
        background: theme.palette.bg,
        padding: `${theme.safe.top}px ${theme.safe.side}px ${theme.safe.bottom}px`,
        fontFamily: theme.fonts.ui,
        color: theme.palette.text,
        justifyContent: "center",
      }}
    >
      {title ? <div style={{ fontSize: 56, fontWeight: 700, marginBottom: 32 }}>{title}</div> : null}
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {body}
      </svg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 32px", marginTop: 24, fontSize: 32, color: theme.palette.muted }}>
        {legend.map((l, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 24, height: 24, borderRadius: 6, background: color(i) }} />
            {l}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
