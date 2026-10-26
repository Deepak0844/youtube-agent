import * as React from "react";
import { cn } from "../lib/cn";
import { Button } from "../primitives/button";

/**
 * Static presentation of a gate (Doc 3 §6). No approve logic here: approvals are session-only
 * and arrive in a later phase, so both actions are rendered disabled and take no handler.
 * The consequence is stated as a sentence; the consequential action is the inverted white pill.
 */
export function Gate({ title, consequence, className }: { title: string; consequence: React.ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col gap-4 rounded-card bg-surface p-pad", className)}>
      <h3 className="m-0 min-w-0 text-title font-semibold leading-tight [overflow-wrap:anywhere]">{title}</h3>
      <p className="m-0 min-w-0 text-body text-muted [overflow-wrap:anywhere]">{consequence}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled className="disabled:opacity-100 disabled:cursor-not-allowed">
          Approve
        </Button>
        <Button variant="secondary" disabled className="disabled:cursor-not-allowed">
          Send back
        </Button>
      </div>
      <p className="m-0 text-small text-faint">Preview only. Approving opens in a later phase.</p>
    </section>
  );
}
