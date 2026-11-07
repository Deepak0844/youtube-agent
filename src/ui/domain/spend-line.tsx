import * as React from "react";
import { formatMoney } from "../../server/core/display-format";
import { cn } from "../lib/cn";
import { Pill } from "../primitives/pill";
import { Progress } from "../primitives/progress";

/** Integer micro-USD (1 USD = 1_000_000) to "$4.20", or "$4.20 (₹399.2)" when a rupee rate is given. */
export const formatUsd = (microUsd: number, rate?: number | null): string => formatMoney(microUsd, rate);

/** "$4.20 of $15.00 today", a 3 px bar and, over the cap, the words for it. */
export function SpendLine({ spentMicroUsd, capMicroUsd, rate, className }: { spentMicroUsd: number; capMicroUsd: number; rate?: number | null; className?: string }) {
  const pct = capMicroUsd > 0 ? Math.min(100, Math.round((spentMicroUsd / capMicroUsd) * 100)) : 0;
  const over = capMicroUsd > 0 && spentMicroUsd > capMicroUsd;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 text-body tabular-nums [overflow-wrap:anywhere]">{`${formatUsd(spentMicroUsd, rate)} of ${formatUsd(capMicroUsd, rate)} today`}</span>
        {over && <Pill tone="negative">Over today&apos;s cap</Pill>}
      </div>
      <Progress value={pct} aria-label="Spend today against your cap" />
    </div>
  );
}
