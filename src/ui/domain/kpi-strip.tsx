import * as React from "react";
import { cn } from "../lib/cn";

export interface Kpi {
  label: string;
  /** null = unknown: printed as an en dash, never a made-up zero. */
  value: number | string | null;
  /** Names the baseline of a relative figure, e.g. "vs last Monday". */
  note?: string;
}

const WRAP = "min-w-0 [overflow-wrap:anywhere]";

function Figure({ k, size }: { k: Kpi; size: "lead" | "plain" }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", size === "lead" ? "basis-full sm:basis-auto" : "")}>
      <dt className={cn("text-small text-muted", WRAP)}>{k.label}</dt>
      <dd className="m-0 flex min-w-0 flex-col">
        {k.value === null ? (
          <>
            <span className={cn("font-semibold leading-none tabular-nums text-faint", size === "lead" ? "text-[36px]" : "text-kpi")}>–</span>
            <span className="sr-only">not known yet</span>
          </>
        ) : (
          <span className={cn("font-semibold leading-none tabular-nums", size === "lead" ? "text-[36px]" : "text-kpi")}>{k.value}</span>
        )}
        {k.note && <span className={cn("mt-1 text-small text-faint", WRAP)}>{k.note}</span>}
      </dd>
    </div>
  );
}

/** KPIs are type, not tiles: no icon, no sparkline, no up/down chip. The lead answers the screen's question. */
export function KpiStrip({ lead, figures, className }: { lead: Kpi; figures: Kpi[]; className?: string }) {
  return (
    <dl className={cn("m-0 flex flex-wrap items-end gap-x-10 gap-y-4", className)}>
      <Figure k={lead} size="lead" />
      {figures.map((f) => (
        <Figure key={f.label} k={f} size="plain" />
      ))}
    </dl>
  );
}
