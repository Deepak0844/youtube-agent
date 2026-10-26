import { cn, focusRing } from "../lib/cn";

/** First tab stop on every page of the shell. Hidden until focused. */
export function SkipLink() {
  return (
    <a
      href="#main"
      className={cn(
        "sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:flex focus:min-h-11 focus:items-center focus:rounded-control focus:bg-text focus:px-4 focus:text-body focus:font-medium focus:text-ground",
        focusRing,
      )}
    >
      Skip to content
    </a>
  );
}
