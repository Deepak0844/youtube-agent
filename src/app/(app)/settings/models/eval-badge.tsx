import { microToUsd } from "@/server/core/llm-catalog";
import type { Badge } from "@/server/core/eval-rules";

// The "tested" badge: the verdict of the latest Draft eval (numbers and fixed words only), with its date and cost.

const WHEN = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

export function EvalBadge({ badge }: { badge: Badge | undefined }) {
  if (!badge) return <p className="text-small text-faint">Draft mode not evaluated: uses search-then-write.</p>;
  return (
    <p className="text-small text-muted">
      <span className={badge.mode === "agent" ? "text-positive" : "text-text"}>{badge.label}</span>
      {badge.detail ? <span> · {badge.detail}</span> : null}
      <span className="text-faint"> · {WHEN.format(badge.at)} UTC · cost ${microToUsd(badge.costMicroUsd)}</span>
    </p>
  );
}
