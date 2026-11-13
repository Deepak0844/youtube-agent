// Claude usage shown to the owner (engine-core spec): a plain line per engine step, and on Health an estimate of how many more
// videos fit in the current 5-hour window. Claude does not tell the window's size, so it is learned from the tokens used in the
// 5 hours before the last time the limit was hit. With no limit seen yet, or fewer than 3 videos, there is no estimate.

export const WINDOW_MS = 5 * 60 * 60 * 1000;

export function estimateVideosLeft(a: { capacityTokens: number | null; usedTokens: number; perVideoTokens: readonly number[] }): number | null {
  if (a.capacityTokens === null || a.perVideoTokens.length < 3) return null;
  const avg = a.perVideoTokens.reduce((x, y) => x + y, 0) / a.perVideoTokens.length;
  if (!(avg > 0)) return null;
  return Math.max(0, Math.floor((a.capacityTokens - a.usedTokens) / avg));
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function usageLine(u: { inputTokens: number; outputTokens: number; costUsdEquiv: number; turns: number }): string {
  return `Claude: ${k(u.inputTokens + u.outputTokens)} tokens, ${u.turns} turn${u.turns === 1 ? "" : "s"}, about $${u.costUsdEquiv.toFixed(2)} API-equivalent (not billed)`;
}
