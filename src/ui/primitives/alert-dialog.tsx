import * as React from "react";
import * as A from "@radix-ui/react-alert-dialog";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { overlay } from "./dialog";

export const AlertDialog = A.Root;
export const AlertDialogTrigger = A.Trigger;
export const AlertDialogTitle = ({ className, ...p }: React.ComponentProps<typeof A.Title>) => (
  <A.Title className={cn("text-title font-semibold", className)} {...p} />
);
export const AlertDialogDescription = ({ className, ...p }: React.ComponentProps<typeof A.Description>) => (
  <A.Description className={cn("text-body text-muted", className)} {...p} />
);
export const AlertDialogCancel = (p: React.ComponentProps<typeof A.Cancel>) => (
  <A.Cancel asChild>
    <Button variant="secondary" {...p} />
  </A.Cancel>
);
export const AlertDialogAction = ({ variant = "destructive", ...p }: React.ComponentProps<typeof A.Action> & { variant?: "primary" | "destructive" }) => (
  <A.Action asChild>
    <Button variant={variant} {...p} />
  </A.Action>
);

export function AlertDialogContent({ className, ...props }: React.ComponentProps<typeof A.Content>) {
  return (
    <A.Portal>
      <A.Overlay className={overlay} />
      <A.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-gap rounded-card bg-raised p-pad text-text",
          className,
        )}
        {...props}
      />
    </A.Portal>
  );
}
