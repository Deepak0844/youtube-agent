import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cellRange, visibleCount } from "./helpers";
import { theme } from "./theme";

export type SpreadsheetProps = {
  rows: string[][]; // rows[0] is the header
  formula?: string;
  highlight: string[];
  reveal: "row" | "cell" | "all";
  framesPerStep: number;
};

const ROW_H = 96;

export const Spreadsheet: React.FC<SpreadsheetProps> = ({ rows, formula, highlight, reveal, framesPerStep }) => {
  const frame = useCurrentFrame();
  const cols = rows[0]?.length ?? 1;
  const total = reveal === "cell" ? rows.length * cols : rows.length;
  const shown = reveal === "all" ? total : visibleCount(frame, framesPerStep, total);
  const ranges = highlight.map(cellRange).filter((r) => r !== null);
  const isShown = (r: number, c: number) => (reveal === "cell" ? r * cols + c < shown : r < shown);
  const isLit = (r: number, c: number) => ranges.some((g) => c >= g.c1 && c <= g.c2 && r >= g.r1 && r <= g.r2);
  const border = `2px solid ${theme.palette.gridLine}`;
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
      <div style={{ display: "flex", alignItems: "center", height: 80, marginBottom: 16, background: theme.palette.surface, border, fontFamily: theme.fonts.mono, fontSize: 38 }}>
        <span style={{ padding: "0 20px", color: theme.palette.accent, fontStyle: "italic" }}>fx</span>
        <span style={{ whiteSpace: "nowrap", overflow: "hidden" }}>{formula ?? ""}</span>
      </div>
      <div style={{ border }}>
        {rows.map((row, r) => (
          <div key={r} style={{ display: "flex", height: ROW_H, borderTop: r ? border : "none", background: r === 0 ? theme.palette.surface : "transparent" }}>
            {row.map((text, c) => {
              const lit = isShown(r, c) && isLit(r, c);
              return (
                <div
                  key={c}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    padding: "0 16px",
                    borderLeft: c ? border : "none",
                    fontSize: 40,
                    fontWeight: r === 0 ? 700 : 500,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    outline: lit ? `5px solid ${theme.palette.highlight}` : "none",
                    outlineOffset: -5,
                    background: lit ? `${theme.palette.highlight}26` : "transparent",
                    opacity: isShown(r, c) ? 1 : 0,
                  }}
                >
                  {text}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
