import { z } from "zod";
import { base, copy, LIMITS } from "./common";

// z.number() already rejects NaN and Infinity; also keep values non-negative and sane.
const value = z
  .number()
  .min(0, "must be 0 or more")
  .max(LIMITS.chartMaxValue, `must be at most ${LIMITS.chartMaxValue}`);

export const schema = z
  .object({
    ...base,
    kind: z.literal("chart"),
    chart: z.enum(["bar", "line", "pie"]),
    title: copy(LIMITS.title).optional(),
    labels: z.array(copy(LIMITS.chartLabel)).min(1).max(LIMITS.chartPoints, `must have at most ${LIMITS.chartPoints} labels`),
    series: z
      .array(z.object({ name: copy(LIMITS.chartLabel).optional(), values: z.array(value).min(1).max(LIMITS.chartPoints) }))
      .min(1)
      .max(LIMITS.chartSeries, `must have at most ${LIMITS.chartSeries} series`),
  })
  .superRefine((c, ctx) => {
    c.series.forEach((s, i) => {
      if (s.values.length !== c.labels.length)
        ctx.addIssue({ code: "custom", path: ["series", i, "values"], message: `needs one value per label (${c.labels.length})` });
    });
    if (c.chart === "pie") {
      if (c.series.length !== 1) ctx.addIssue({ code: "custom", path: ["series"], message: "a pie chart needs exactly one series" });
      else if (!(c.series[0]!.values.reduce((a, b) => a + b, 0) > 0))
        ctx.addIssue({ code: "custom", path: ["series", 0, "values"], message: "pie values must add up to more than 0" });
    }
  });

export const describe = `kind "chart": chart ("bar", "line" or "pie"); labels[] (max ${LIMITS.chartPoints}, each max ${LIMITS.chartLabel} chars); series[] (max ${LIMITS.chartSeries}; pie needs exactly 1), each {name (optional, max ${LIMITS.chartLabel}), values[] (one finite number >= 0 per label)}; optional title (max ${LIMITS.title}).`;
