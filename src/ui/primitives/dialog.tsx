import * as React from "react";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn, fade, focusRing } from "../lib/cn";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;
export const DialogTitle = ({ className, ...p }: React.ComponentProps<typeof D.Title>) => (
  <D.Title className={cn("text-title font-semibold", className)} {...p} />
);
export const DialogDescription = ({ className, ...p }: React.ComponentProps<typeof D.Description>) => (
  <D.Description className={cn("text-body text-muted", className)} {...p} />
);

export const overlay = "fixed inset-0 z-40 bg-ground/80";

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Overlay className={overlay} />
      <D.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-gap overflow-auto rounded-card bg-raised p-pad text-text",
          className,
        )}
        {...props}
      >
        {children}
        <D.Close
          aria-label="Close"
          className={cn("absolute top-3 right-3 flex size-11 items-center justify-center rounded-control text-muted hover:text-text sm:size-9", fade, focusRing)}
        >
          <X size={16} aria-hidden />
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}
