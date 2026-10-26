import * as React from "react";
import { cn, control, fade, focusRing } from "../lib/cn";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "w-full rounded-control border border-control bg-surface px-4 text-body text-text placeholder:text-faint aria-invalid:border-negative disabled:opacity-50",
        control,
        fade,
        focusRing,
        className,
      )}
      {...props}
    />
  );
}
