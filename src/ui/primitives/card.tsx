import * as React from "react";
import { cn } from "../lib/cn";

/** Bordered card on the page (spec §4.1): 8 px radius, 1 px border. */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-card border border-border bg-surface p-pad text-text", className)} {...props} />;
}

/** Card title row: title (h2), optional one-line description, actions on the right. */
export function CardHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-title font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-small text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex min-w-0 flex-col gap-gap", className)} {...props} />;
}
