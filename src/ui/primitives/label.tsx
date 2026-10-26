import * as React from "react";
import * as L from "@radix-ui/react-label";
import { cn } from "../lib/cn";

export function Label({ className, ...props }: React.ComponentProps<typeof L.Root>) {
  return <L.Root className={cn("text-small font-medium text-muted", className)} {...props} />;
}
