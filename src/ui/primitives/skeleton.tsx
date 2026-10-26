import * as React from "react";
import { cn } from "../lib/cn";

/** A tone step above the surface; pulses only when motion is allowed. */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div aria-hidden className={cn("rounded-card bg-raised motion-safe:animate-pulse", className)} {...props} />;
}
