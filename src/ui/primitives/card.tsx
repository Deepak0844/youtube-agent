import * as React from "react";
import { cn } from "../lib/cn";

/** Tonal surface. Elevation is lightness only: flat, no outline or drop effect. */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-card bg-surface p-pad text-text", className)} {...props} />;
}
