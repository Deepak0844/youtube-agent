// Targets (Phase 6, parity with the old agent/targets.py): numbers per channel that say what "working" means. Pure, no IO.
// Subscribers per week is a channel number, not a per-short one: actuals() leaves it empty and the db layer fills it in.
export const TARGET_METRICS = {
  avg_view_pct: { label: "Average view %", op: ">=", unit: "%", start: 70 },
  views: { label: "Views per short (median)", op: ">=", unit: "", start: null },
  cost_per_short: { label: "Cost per short", op: "<=", unit: "$", start: 2 },
  cost_per_1k_views: { label: "Cost per 1,000 views", op: "<=", unit: "$", start: null },
  subscribers_per_week: { label: "Subscribers gained per week (net)", op: ">=", unit: "", start: null },
} as const;
export type TargetMetric = keyof typeof TARGET_METRICS;
export const TARGET_METRIC_IDS = Object.keys(TARGET_METRICS) as TargetMetric[];
export const isTargetMetric = (v: unknown): v is TargetMetric => typeof v === "string" && Object.hasOwn(TARGET_METRICS, v);

/** Below this many shorts with data a target says "not enough data" (old app: min_sample 5). */
export const TARGET_MIN_SAMPLE = 5;
export const MAX_PAUSE_SHORTS = 50;

export interface ShortNumbers {
  views: number | null;
  avgViewPct: number | null;
  spendMicroUsd: number;
}
export type Actual = { value: number | null; n: number };

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round = (x: number, d: number): number => Math.round(x * 10 ** d) / 10 ** d;

/** The actual number for each metric, straight from the shorts' newest snapshots and their spend. */
export function actuals(shorts: readonly ShortNumbers[]): Record<TargetMetric, Actual> {
  const pcts = shorts.flatMap((s) => (s.avgViewPct === null ? [] : [s.avgViewPct]));
  const views = shorts.flatMap((s) => (s.views === null ? [] : [s.views]));
  const withViews = shorts.filter((s) => (s.views ?? 0) > 0);
  const totalViews = withViews.reduce((a, s) => a + (s.views ?? 0), 0);
  const totalSpend = withViews.reduce((a, s) => a + s.spendMicroUsd, 0) / 1e6;
  return {
    avg_view_pct: { value: pcts.length ? round(pcts.reduce((a, b) => a + b, 0) / pcts.length, 1) : null, n: pcts.length },
    views: { value: views.length ? median(views) : null, n: views.length },
    cost_per_short: { value: shorts.length ? round(shorts.reduce((a, s) => a + s.spendMicroUsd, 0) / 1e6 / shorts.length, 2) : null, n: shorts.length },
    cost_per_1k_views: { value: totalViews > 0 ? round(totalSpend / (totalViews / 1000), 2) : null, n: withViews.length },
    subscribers_per_week: { value: null, n: 0 },
  };
}

/** Net subscribers over the latest good weekly row of each channel in scope (gained minus lost); n = channels with data. */
export function subscriberActual(rows: ReadonlyArray<{ gained: number | null; lost: number | null }>): Actual {
  const ok = rows.filter((r) => r.gained !== null);
  return { value: ok.length ? ok.reduce((a, r) => a + r.gained! - (r.lost ?? 0), 0) : null, n: ok.length };
}

export type TargetStatus = "on_track" | "behind" | "no_data";
export function evaluate(a: Actual, op: ">=" | "<=", target: number, minSample = TARGET_MIN_SAMPLE): TargetStatus {
  if (a.value === null || a.n < minSample) return "no_data";
  return (op === ">=" ? a.value >= target : a.value <= target) ? "on_track" : "behind";
}

/** An estimate from a manual RPM (dollars per 1,000 views). Always labelled an estimate: shorts earn little and only after monetization. */
export function revenueEstimateUsd(totalViews: number, rpmUsd: number): number | null {
  return rpmUsd > 0 ? round((totalViews / 1000) * rpmUsd, 2) : null;
}

/** True when cost per 1,000 views was over the target for EACH of the last n shorts (n = 0 means the rule is off). Shorts without views are skipped. */
export function overTargetForLast(shortsOldestFirst: readonly ShortNumbers[], n: number, targetUsd: number): boolean {
  if (n <= 0) return false;
  const last = shortsOldestFirst.filter((s) => (s.views ?? 0) > 0).slice(-n);
  return last.length === n && last.every((s) => s.spendMicroUsd / 1e6 / ((s.views ?? 0) / 1000) > targetUsd);
}
