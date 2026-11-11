import * as React from "react";
import { cn } from "../lib/cn";

// Status badge (spec §4.1): amber/warning = waiting for you, info = cost approval, positive = OK, negative = failed,
// neutral = running/idle. A dot in the text colour leads the word.
const tones = {
  positive: "bg-pill-positive-bg text-pill-positive-ink",
  negative: "bg-pill-negative-bg text-pill-negative-ink",
  warning: "bg-pill-warning-bg text-pill-warning-ink",
  info: "bg-pill-info-bg text-pill-info-ink",
  neutral: "bg-pill-neutral-bg text-pill-neutral-ink",
} as const;

/** Status always carries a word; the tint is a second channel, never the only one. */
export function Pill({ tone = "neutral", className, ...props }: React.ComponentProps<"span"> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-small font-medium whitespace-nowrap",
        "before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
