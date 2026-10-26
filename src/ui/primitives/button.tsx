import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn, control, fade, focusRing } from "../lib/cn";

const variants = {
  primary: "bg-text text-ground hover:bg-muted",
  secondary: "bg-raised text-text hover:bg-control",
  ghost: "bg-transparent text-muted hover:bg-raised hover:text-text",
  destructive: "bg-pill-negative-bg text-pill-negative-ink hover:bg-raised",
} as const;

export type ButtonProps = React.ComponentProps<"button"> & {
  variant?: keyof typeof variants;
  asChild?: boolean;
};

export function Button({ variant = "primary", asChild, className, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      type={asChild ? undefined : (type ?? "button")}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-control px-4 text-body font-medium whitespace-nowrap disabled:pointer-events-none disabled:opacity-50",
        control,
        fade,
        focusRing,
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
