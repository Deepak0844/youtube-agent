import * as React from "react";
import { cn, focusRing } from "../lib/cn";
import { Pill } from "../primitives/pill";
import { Skeleton } from "../primitives/skeleton";

export interface LogLine {
  time: string;
  level: "info" | "warn" | "error";
  text: string;
}

const TONE = { info: "neutral", warn: "warning", error: "negative" } as const;

/** The last `max` lines of a job log. Level is a word, never a colour alone; long lines wrap. */
export function LogTail({ lines, max = 50, loading, className }: { lines: LogLine[]; max?: number; loading?: boolean; className?: string }) {
  const shown = lines.slice(-max);
  return (
    <div role="log" aria-label="Job log" tabIndex={0} className={cn("min-w-0 max-h-72 overflow-y-auto rounded-card bg-surface p-pad", focusRing, className)}>
      {loading ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">Loading the log</span>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : shown.length === 0 ? (
        <p className="m-0 text-body text-muted">Nothing logged yet.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-small">
          {shown.map((l, i) => (
            <li key={i} className="grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-3">
              <time className="tabular-nums text-faint">{l.time}</time>
              <Pill tone={TONE[l.level]}>{l.level}</Pill>
              <span className="min-w-0 [overflow-wrap:anywhere]">{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
