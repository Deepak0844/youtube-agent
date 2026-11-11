import * as React from "react";
import * as P from "@radix-ui/react-progress";
import { cn } from "../lib/cn";

/** 3 px track. Always give it an accessible name (aria-label). */
export function Progress({ value, className, ...props }: React.ComponentProps<typeof P.Root>) {
  return (
    <P.Root value={value} className={cn("h-1 w-full overflow-hidden rounded-full bg-raised", className)} {...props}>
      <P.Indicator className="h-full bg-text" style={{ width: `${value ?? 0}%` }} />
    </P.Root>
  );
}
