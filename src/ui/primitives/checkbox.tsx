import * as React from "react";
import * as C from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn, fade, focusRing } from "../lib/cn";

export function Checkbox({ className, ...props }: React.ComponentProps<typeof C.Root>) {
  return (
    <C.Root
      className={cn(
        "relative flex size-5 shrink-0 items-center justify-center rounded-md border border-control bg-surface text-ground data-[state=checked]:border-text data-[state=checked]:bg-text disabled:opacity-50",
        "before:absolute before:-inset-3 before:content-[''] sm:before:hidden",
        fade,
        focusRing,
        className,
      )}
      {...props}
    >
      <C.Indicator>
        <Check size={14} strokeWidth={2.5} aria-hidden />
      </C.Indicator>
    </C.Root>
  );
}
