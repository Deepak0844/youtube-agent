"use client";
import { Toaster as Sonner, type ToasterProps } from "sonner";

export { toast } from "sonner";
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "flex w-full items-center gap-3 rounded-card bg-raised p-4 text-body text-text",
          description: "text-small text-muted",
        },
      }}
      {...props}
    />
  );
}
