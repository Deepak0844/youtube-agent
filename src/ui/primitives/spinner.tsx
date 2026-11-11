import { LoaderCircle } from "lucide-react";
import { cn } from "../lib/cn";

/** Small turning circle for buttons and inline waits. Still (no spin) when the Mac asks for reduced motion. */
export function Spinner({ className, size = 14 }: { className?: string; size?: number }) {
  return <LoaderCircle data-spinner aria-hidden size={size} className={cn("shrink-0 motion-safe:animate-spin", className)} />;
}
