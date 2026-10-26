import * as React from "react";
import * as T from "@radix-ui/react-tooltip";
import { cn } from "../lib/cn";

export const TooltipProvider = T.Provider;
export const Tooltip = T.Root;
export const TooltipTrigger = T.Trigger;
export function TooltipContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof T.Content>) {
  return (
    <T.Portal>
      <T.Content
        sideOffset={sideOffset}
        className={cn("z-50 rounded-lg bg-raised px-2.5 py-1.5 text-small text-text", className)}
        {...props}
      />
    </T.Portal>
  );
}
