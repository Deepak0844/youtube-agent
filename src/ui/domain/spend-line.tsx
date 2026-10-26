import * as React from "react";
import { cn } from "../lib/cn";
import { Pill } from "../primitives/pill";
import { Progress } from "../primitives/progress";

/** Integer micro-USD (1 USD = 1_000_000) to "$4.20". */
export const formatUsd = (microUsd: number): string => `$${(Math.round(microUsd / 10_000) / 100).toFixed(2)}`;

/** "$4.20 of $15.00 today", a 3 px bar and, over the cap, the words for it. */
export function SpendLine({ spentMicroUsd, capMicroUsd, className }: { spentMicroUsd: number; capMicroUsd: number; className?: string }) {
  const pct = capMicroUsd > 0 ? Math.min(100, Math.round((spentMicroUsd / capMicroUsd) * 100)) : 0;
  const over = capMicroUsd > 0 && spentMicroUsd > capMicroUsd;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 text-body tabular-nums [overflow-wrap:anywhere]">{`${formatUsd(spentMicroUsd)} of ${formatUsd(capMicroUsd)} today`}</span>
        {over && <Pill tone="negative">Over today&apos;s cap</Pill>}
      </div>
      <Progress value={pct} aria-label="Spend today against your cap" />
    </div>
  );
}
