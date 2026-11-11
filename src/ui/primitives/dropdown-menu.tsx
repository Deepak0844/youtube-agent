import * as React from "react";
import * as M from "@radix-ui/react-dropdown-menu";
import { cn } from "../lib/cn";

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuContent = ({ className, sideOffset = 6, ...p }: React.ComponentProps<typeof M.Content>) => (
  <M.Portal>
    <M.Content sideOffset={sideOffset} className={cn("min-w-44 z-50 rounded-card border border-border bg-surface p-1 text-text shadow-lg", className)} {...p} />
  </M.Portal>
);
export const DropdownMenuItem = ({ className, ...p }: React.ComponentProps<typeof M.Item>) => (
  <M.Item
    className={cn(
      "flex min-h-11 cursor-default items-center gap-2 rounded-control px-3 text-body data-[disabled]:opacity-50 data-[highlighted]:bg-raised data-[highlighted]:outline-none sm:min-h-9",
      className,
    )}
    {...p}
  />
);
export const DropdownMenuSeparator = ({ className, ...p }: React.ComponentProps<typeof M.Separator>) => (
  <M.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...p} />
);
export const DropdownMenuLabel = ({ className, ...p }: React.ComponentProps<typeof M.Label>) => (
  <M.Label className={cn("px-3 py-1.5 text-small text-muted", className)} {...p} />
);
export const DropdownMenuRadioGroup = M.RadioGroup;
export const DropdownMenuRadioItem = ({ className, children, ...p }: React.ComponentProps<typeof M.RadioItem>) => (
  <M.RadioItem
    className={cn(
      "flex min-h-11 cursor-default items-center gap-2 rounded-control px-3 text-body data-[highlighted]:bg-raised data-[highlighted]:outline-none sm:min-h-9",
      className,
    )}
    {...p}
  >
    <span aria-hidden className="flex size-3.5 items-center justify-center">
      <M.ItemIndicator>
        <span className="block size-1.5 rounded-full bg-text" />
      </M.ItemIndicator>
    </span>
    {children}
  </M.RadioItem>
);
