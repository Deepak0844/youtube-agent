import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn, control, fade, focusRing } from "../lib/cn";
import { Spinner } from "./spinner";

// shadcn new-york button, mapped to our tokens (spec 2026-11-12 §4.1): primary = solid text colour, secondary = bordered.
const variants = {
  primary: "bg-text text-page hover:bg-text/85",
  secondary: "border border-border bg-surface text-text hover:bg-raised",
  ghost: "bg-transparent text-muted hover:bg-raised hover:text-text",
  destructive: "bg-negative text-page hover:bg-negative/85",
} as const;
const sizes = { sm: "h-8 px-3 text-small", md: "px-3.5 text-body" } as const;

export type ButtonProps = React.ComponentProps<"button"> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  asChild?: boolean;
  /** Shows a spinner before the label, disables the button and marks it busy. Width does not change. */
  loading?: boolean;
};

export function Button({ variant = "primary", size = "md", asChild, loading = false, className, type, disabled, children, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      type={asChild ? undefined : (type ?? "button")}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading ? true : undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap disabled:pointer-events-none disabled:opacity-50 aria-busy:opacity-80",
        control,
        fade,
        focusRing,
        sizes[size],
        variants[variant],
        className,
      )}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && <Spinner />}
          {children}
        </>
      )}
    </Comp>
  );
}
