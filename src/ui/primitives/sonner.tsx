"use client";
import { Toaster as Sonner, type ToasterProps } from "sonner";

export { toast } from "sonner";
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "flex w-full items-center gap-3 rounded-card border border-border bg-surface p-4 text-body text-text overlay-lift",
          description: "text-small text-muted",
        },
      }}
      {...props}
    />
  );
}
