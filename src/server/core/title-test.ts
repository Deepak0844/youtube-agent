// Sequential title test (Phase 6 piece 6.5, parity with the old agent/titles.py). Pure: no IO, no calls to YouTube.
// Title A runs for one window, title B for the next window of the same video, and views per day are compared. The audience and the
// timing differ between windows, so a result is always labelled confounded. Advisory only: nothing is ever switched on its own.
export const MIN_VIEWS = 200; // across both windows
export const MIN_REL_DIFF = 0.2;
export const P_LIMIT = 0.05;

/** Are two counts consistent with the same daily rate? Conditional binomial test, normal approximation, two-sided. */
export function twoSidedP(nA: number, daysA: number, nB: number, daysB: number): number {
  const n = nA + nB;
  if (n === 0 || daysA <= 0 || daysB <= 0) return 1;
  const p0 = daysA / (daysA + daysB);
  const sd = Math.sqrt(n * p0 * (1 - p0));
  if (sd === 0) return 1;
  return erfc(Math.abs(nA - n * p0) / sd / Math.SQRT2);
}

// Abramowitz-Stegun 7.1.26: absolute error under 1.5e-7, far finer than the 0.05 line it is compared with.
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return poly * Math.exp(-x * x);
}

export interface Window {
  views: number;
  days: number;
  avgViewPct: number | null;
}
export type Verdict = "a_better" | "b_better" | "no_conclusion";
export interface TitleTestResult {
  verdict: Verdict;
  reason: string;
  confounded: true;
  note: string;
  rateA?: number;
  rateB?: number;
  relDiff?: number | null;
  p?: number;
}

const NOTE = "Sequential windows: the audience and timing differ, so this is a hint, not proof.";

export function concludeTitleTest(a: Window, b: Window): TitleTestResult {
  const out = { confounded: true as const, note: NOTE };
  const total = a.views + b.views;
  if (total < MIN_VIEWS) return { ...out, verdict: "no_conclusion", reason: `only ${total} views across both windows (needs ${MIN_VIEWS})` };
  const rateA = a.views / a.days;
  const rateB = b.views / b.days;
  const relDiff = rateA ? (rateB - rateA) / rateA : null;
  const p = twoSidedP(a.views, a.days, b.views, b.days);
  const stats = { rateA: Math.round(rateA * 10) / 10, rateB: Math.round(rateB * 10) / 10, relDiff: relDiff === null ? null : Math.round(relDiff * 1000) / 1000, p: Math.round(p * 10_000) / 10_000 };
  if (relDiff === null || p >= P_LIMIT || Math.abs(relDiff) < MIN_REL_DIFF) {
    return { ...out, ...stats, verdict: "no_conclusion", reason: "the difference is small or could be chance" };
  }
  return {
    ...out,
    ...stats,
    verdict: relDiff > 0 ? "b_better" : "a_better",
    reason: `B's views per day were ${relDiff > 0 ? "+" : "-"}${Math.round(Math.abs(relDiff) * 100)}% versus A's (p=${p.toFixed(3)})`,
  };
}
