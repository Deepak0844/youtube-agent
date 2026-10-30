import { z } from "zod";
import { base, copy, LIMITS } from "./common";

const RANGE = /^([A-D])([1-9])(?::([A-D])([1-9]))?$/;
const cell = z.string().trim().max(LIMITS.sheetCell, `must be at most ${LIMITS.sheetCell} characters`);

export const schema = z
  .object({
    ...base,
    kind: z.literal("spreadsheet"),
    // rows[0] is the header row. Cells are short text; numbers go in as text ("3").
    rows: z
      .array(z.array(cell).min(1).max(LIMITS.sheetCols, `must have at most ${LIMITS.sheetCols} columns`))
      .min(1)
      .max(LIMITS.sheetRows, `must have at most ${LIMITS.sheetRows} rows`),
    formula: copy(LIMITS.sheetFormula).optional(), // text shown in the formula bar
    highlight: z
      .array(z.string().regex(RANGE, "must look like 'B2' or 'A1:B3' (columns A-D, rows 1-8)"))
      .max(LIMITS.sheetHighlights, `must have at most ${LIMITS.sheetHighlights} ranges`)
      .default([]),
    reveal: z.enum(["row", "cell", "all"]).default("row"),
  })
  .superRefine((s, ctx) => {
    const cols = s.rows[0]?.length ?? 0;
    if (s.rows.some((r) => r.length !== cols))
      ctx.addIssue({ code: "custom", path: ["rows"], message: "every row must have the same number of cells" });
    s.highlight.forEach((h, i) => {
      const m = RANGE.exec(h);
      if (!m) return;
      const col = (l: string) => l.charCodeAt(0) - 65;
      const out = col(m[1]!) >= cols || Number(m[2]) > s.rows.length || (m[3] && (col(m[3]) >= cols || Number(m[4]) > s.rows.length));
      if (out) ctx.addIssue({ code: "custom", path: ["highlight", i], message: `'${h}' is outside the ${cols} x ${s.rows.length} grid` });
    });
  });

export const describe = `kind "spreadsheet": rows[][] (max ${LIMITS.sheetRows} rows x ${LIMITS.sheetCols} columns, every row the same length, first row is the header, each cell text of max ${LIMITS.sheetCell} characters); optional formula (formula-bar text, max ${LIMITS.sheetFormula}), highlight[] (max ${LIMITS.sheetHighlights} ranges like "B2" or "A1:B3", columns A-D), reveal ("row" default, "cell" or "all").`;
