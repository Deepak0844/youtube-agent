import * as React from "react";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn, fade, focusRing } from "../lib/cn";
import { overlay } from "./dialog";

export const Sheet = D.Root;
export const SheetTrigger = D.Trigger;
export const SheetTitle = ({ className, ...p }: React.ComponentProps<typeof D.Title>) => (
  <D.Title className={cn("text-title font-semibold", className)} {...p} />
);
export const SheetDescription = ({ className, ...p }: React.ComponentProps<typeof D.Description>) => (
  <D.Description className={cn("text-body text-muted", className)} {...p} />
);

const sides = {
  right: "inset-y-0 right-0 w-[min(100%,24rem)]",
  left: "inset-y-0 left-0 w-[min(100%,24rem)]",
  bottom: "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-card",
} as const;

export function SheetContent({ side = "right", className, children, ...props }: React.ComponentProps<typeof D.Content> & { side?: keyof typeof sides }) {
  return (
    <D.Portal>
      <D.Overlay className={overlay} />
      <D.Content className={cn("fixed z-50 flex flex-col gap-gap overflow-auto bg-raised p-pad text-text", sides[side], className)} {...props}>
        {children}
        <D.Close aria-label="Close" className={cn("absolute top-3 right-3 flex size-11 items-center justify-center rounded-control text-muted hover:text-text", fade, focusRing)}>
          <X size={16} aria-hidden />
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}
