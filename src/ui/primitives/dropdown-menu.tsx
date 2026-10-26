import * as React from "react";
import * as M from "@radix-ui/react-dropdown-menu";
import { cn } from "../lib/cn";

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuContent = ({ className, sideOffset = 6, ...p }: React.ComponentProps<typeof M.Content>) => (
  <M.Portal>
    <M.Content sideOffset={sideOffset} className={cn("z-50 min-w-44 rounded-card bg-raised p-1.5 text-text", className)} {...p} />
  </M.Portal>
);
export const DropdownMenuItem = ({ className, ...p }: React.ComponentProps<typeof M.Item>) => (
  <M.Item
    className={cn(
      "flex min-h-11 cursor-default items-center gap-2 rounded-control px-3 text-body data-[disabled]:opacity-50 data-[highlighted]:bg-control data-[highlighted]:outline-none sm:min-h-9",
      className,
    )}
    {...p}
  />
);
export const DropdownMenuSeparator = ({ className, ...p }: React.ComponentProps<typeof M.Separator>) => (
  <M.Separator className={cn("my-1 h-px bg-control", className)} {...p} />
);
