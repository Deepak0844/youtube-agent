import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cellsAt, type AlgoStep } from "./helpers";
import { theme } from "./theme";

export type AlgoCellsProps = {
  title?: string;
  cells: string[];
  steps: AlgoStep[];
};

export const AlgoCells: React.FC<AlgoCellsProps> = ({ title, cells, steps }) => {
  const frame = useCurrentFrame();
  const { values, active, pointer, done } = cellsAt(cells, steps, (frame / theme.fps) * 1000);
  const perRow = cells.length > 5 ? Math.ceil(cells.length / 2) : cells.length; // two rows when wide
  const inner = theme.width - 2 * theme.safe.side;
  const gap = 16;
  const size = Math.min(150, Math.floor((inner - (perRow - 1) * gap) / perRow));
  const rows = [values.slice(0, perRow), values.slice(perRow)].filter((r) => r.length);
  return (
    <AbsoluteFill
      style={{
        background: theme.palette.bg,
        padding: `${theme.safe.top}px ${theme.safe.side}px ${theme.safe.bottom}px`,
        fontFamily: theme.fonts.mono,
        color: theme.palette.text,
        justifyContent: "center",
        alignItems: "center",
        gap: 56,
      }}
    >
      {title ? <div style={{ fontFamily: theme.fonts.ui, fontSize: 52, color: theme.palette.muted }}>{title}</div> : null}
      {rows.map((row, r) => (
        <div key={r} style={{ display: "flex", gap }}>
          {row.map((v, c) => {
            const idx = r * perRow + c;
            const isDone = done.includes(idx);
            const isActive = active.includes(idx);
            const isPtr = pointer === idx;
            return (
              <div key={idx} style={{ width: size, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    width: size,
                    height: size,
                    borderRadius: 20,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: size > 110 ? 56 : 44,
                    background: isDone ? theme.palette.accent : theme.palette.surface,
                    color: isDone ? theme.palette.bg : theme.palette.text,
                    border: `4px solid ${isActive ? theme.palette.accent : isPtr ? theme.palette.muted : "transparent"}`,
                  }}
                >
                  {v}
                </div>
                <div style={{ height: 40, fontSize: 40, color: theme.palette.accent }}>{isPtr ? "▲" : ""}</div>
              </div>
            );
          })}
        </div>
      ))}
    </AbsoluteFill>
  );
};
