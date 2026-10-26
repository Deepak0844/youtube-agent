import * as React from "react";
import { cn } from "../lib/cn";

/** Golden-angle step: neighbours are 137.5 degrees apart (>= 60 required, Doc 3 §2). */
export const hueFor = (index: number): number => Math.round(((index * 137.5) % 360) * 10) / 10;

/** Circular distance between two hues, 0-180. */
export const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** A stable pale-tinted initial for a channel. Decorative: the name is always written beside it. */
export function ChannelInitial({ name, index, className }: { name: string; index: number; className?: string }) {
  const first = Array.from(name.trim())[0] ?? "?";
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-control text-small font-semibold text-ground", className)}
      style={{ backgroundColor: `hsl(${hueFor(index)} 55% 80%)` }}
    >
      {first.toLocaleUpperCase()}
    </span>
  );
}
