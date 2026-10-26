import type { GateName, SampleData } from "./data";

export const videoCost = (d: SampleData, videoId: string): number =>
  d.ledger.filter((r) => r.videoId === videoId).reduce((s, r) => s + r.microUsd, 0);

export const dayTotal = (d: SampleData): number =>
  d.ledger.filter((r) => r.day === d.today).reduce((s, r) => s + r.microUsd, 0);

export const monthTotal = (d: SampleData): number =>
  d.ledger.filter((r) => r.day.slice(0, 7) === d.today.slice(0, 7)).reduce((s, r) => s + r.microUsd, 0);

export const gateQueue = (d: SampleData, gate: GateName) =>
  d.videos.filter((v) => v.gate === gate);

/** Whole-cent display, rounded half up. */
export const formatUsd = (microUsd: number): string =>
  `$${(Math.round(microUsd / 10_000) / 100).toFixed(2)}`;

/** Returns a list of problems; empty means the data reconciles. */
export function checkAll(d: SampleData): string[] {
  const errs: string[] = [];
  for (const g of d.gates) {
    if (g.waiting !== gateQueue(d, g.name).length) errs.push(`gate ${g.name} count`);
  }
  for (const v of d.videos) {
    if ((v.status === "held") !== (v.gate !== null)) errs.push(`video ${v.id} status/gate`);
  }
  const ids = new Set(d.videos.map((v) => v.id));
  for (const r of d.ledger) {
    if (!ids.has(r.videoId)) errs.push(`ledger ${r.id} unknown video`);
    if (!Number.isInteger(r.microUsd)) errs.push(`ledger ${r.id} not integer`);
  }
  const shown = d.ledger
    .filter((r) => r.day === d.today)
    .reduce((s, r) => s + Math.round(r.microUsd / 10_000), 0);
  if (shown !== Math.round(dayTotal(d) / 10_000)) errs.push("day total vs displayed parts");
  if (dayTotal(d) > d.budget.dayCapMicroUsd) errs.push("over day cap");
  return errs;
}
