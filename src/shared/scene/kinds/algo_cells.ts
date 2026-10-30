import { z } from "zod";
import { base, copy, LIMITS } from "./common";

const stepTypes = ["highlight", "compare", "swap", "mark_done", "pointer"] as const;
const needsJ = new Set<string>(["compare", "swap"]);

export const schema = z
  .object({
    ...base,
    kind: z.literal("algo_cells"),
    title: copy(LIMITS.title).optional(),
    cells: z
      .array(copy(LIMITS.algoCellText))
      .min(2, "must have at least 2 cells")
      .max(LIMITS.algoCells, `must have at most ${LIMITS.algoCells} cells`),
    steps: z
      .array(
        z.object({
          at: z.number().int().min(0, "must be 0 or more").max(LIMITS.maxSceneMs, `must be at most ${LIMITS.maxSceneMs} ms`),
          type: z.enum(stepTypes),
          i: z.number().int().min(0, "must be 0 or more"), // cell index, 0-based
          j: z.number().int().min(0, "must be 0 or more").optional(), // second cell, for compare and swap
        }),
      )
      .max(LIMITS.algoSteps, `must have at most ${LIMITS.algoSteps} steps`)
      .default([]),
  })
  .superRefine((s, ctx) => {
    const n = s.cells.length;
    let prev = 0;
    s.steps.forEach((st, k) => {
      const at = (path: string, message: string) => ctx.addIssue({ code: "custom", path: ["steps", k, path], message });
      if (st.at < prev) at("at", "steps must be in time order (at must not go backwards)");
      prev = Math.max(prev, st.at);
      if (st.at >= s.durationMs) at("at", `must be before the scene ends (${s.durationMs} ms)`);
      if (st.i >= n) at("i", `must be a cell index from 0 to ${n - 1}`);
      if (needsJ.has(st.type)) {
        if (st.j === undefined) at("j", `is required for ${st.type}`);
        else if (st.j >= n) at("j", `must be a cell index from 0 to ${n - 1}`);
        else if (st.j === st.i) at("j", "must differ from i");
      } else if (st.j !== undefined) at("j", `is only for compare and swap`);
    });
  });

export const describe = `kind "algo_cells": cells[] (${2}-${LIMITS.algoCells} short values, max ${LIMITS.algoCellText} chars each), steps[] (max ${LIMITS.algoSteps}, in time order), each {at (ms from scene start, before the scene ends), type: "highlight"|"compare"|"swap"|"mark_done"|"pointer", i (0-based cell index), j (second index; ONLY for compare and swap)}; optional title (max ${LIMITS.title}). swap really exchanges the two cells.`;
