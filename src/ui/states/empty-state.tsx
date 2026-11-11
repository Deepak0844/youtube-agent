import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/cn";

/**
 * Shared "no data" screen (spec §4.6.3): icon, one line saying what goes here, and the one action that fills it.
 * With `filtered`, the list is empty only because of filters: say so and offer "Clear filters" instead.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  filtered,
  className,
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
  action?: React.ReactNode;
  filtered?: { clearHref: string };
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col items-center justify-center gap-3 rounded-card border border-dashed border-border px-6 py-12 text-center", className)}>
      <span aria-hidden className="flex size-10 items-center justify-center rounded-full border border-border bg-surface text-muted">
        <Icon size={18} />
      </span>
      <h2 className="text-section font-semibold">{filtered ? "No results for these filters" : title}</h2>
      {filtered ? (
        <Link href={filtered.clearHref} className="text-body text-text underline underline-offset-4">
          Clear filters
        </Link>
      ) : (
        <>
          {body && <p className="max-w-[48ch] text-body text-muted">{body}</p>}
          {action}
        </>
      )}
    </div>
  );
}
