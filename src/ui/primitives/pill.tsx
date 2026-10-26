import * as React from "react";
import { cn } from "../lib/cn";

const tones = {
  positive: "bg-pill-positive-bg text-pill-positive-ink",
  negative: "bg-pill-negative-bg text-pill-negative-ink",
  warning: "bg-pill-warning-bg text-pill-warning-ink",
  neutral: "bg-pill-neutral-bg text-pill-neutral-ink",
} as const;

/** Status always carries a word; the tint is a second channel, never the only one. */
export function Pill({ tone = "neutral", className, ...props }: React.ComponentProps<"span"> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn("inline-flex h-5 items-center rounded-control px-2 text-small font-medium whitespace-nowrap", tones[tone], className)}
      {...props}
    />
  );
}
